use std::io::{self, Read};
use std::marker::PhantomData;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(any(test, feature = "test-hooks"))]
use std::cell::RefCell;
#[cfg(feature = "test-hooks")]
use std::fs::OpenOptions;
#[cfg(feature = "test-hooks")]
use std::io::Write;
#[cfg(feature = "test-hooks")]
use std::path::{Path, PathBuf};
#[cfg(any(test, feature = "test-hooks"))]
use std::sync::atomic::AtomicUsize;

use reqwest::Url;
use reqwest::blocking::{Client, ClientBuilder, Response};
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, HeaderMap, HeaderValue};
use reqwest::{redirect, retry};

pub(crate) const STREAM_CHUNK_BYTES: usize = 65_536;

pub(crate) enum HttpRequest {
    Get {
        url: Url,
    },
    Post {
        url: Url,
        headers: HeaderMap,
        body: Vec<u8>,
    },
}

pub(crate) struct TransferLimits {
    pub deadline: Instant,
    pub connect_timeout: Duration,
    pub max_body_bytes: u64,
    #[cfg(any(test, feature = "test-hooks"))]
    pub extra_root_pem: Option<Vec<u8>>,
    #[cfg(any(test, feature = "test-hooks"))]
    pub hooks: TestTransferHooks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DnsFailureReason {
    MissingHost,
    ResolveError,
    EmptyAddresses,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddressFailureReason {
    DisallowedUrl,
    NonLoopbackHttp,
    UnpinnedRemote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetupFailureReason {
    #[cfg(any(test, feature = "test-hooks"))]
    InvalidFixtureCert,
    ClientBuildFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendReadFailureReason {
    SendFailed,
    ReadFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EncodingFailureReason {
    InvalidHeader,
    NonIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RedirectFailureReason {
    TooMany,
    MissingLocation,
    InvalidLocation,
    Fragment,
    MalformedLocation,
    DisallowedTarget,
    HttpsDowngrade,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportFailure {
    Timeout,
    Cancelled,
    SpawnFailed,
    Disconnected,
    Dns(DnsFailureReason),
    AddressPolicy(AddressFailureReason),
    Setup(SetupFailureReason),
    SendOrRead(SendReadFailureReason),
    Encoding(EncodingFailureReason),
    RedirectPolicy(RedirectFailureReason),
    HttpStatus(u16),
    InvalidRequest,
}

pub(crate) enum TransferEvent {
    Head {
        final_url: Url,
        status: u16,
        content_length: Option<u64>,
    },
    Chunk(Vec<u8>),
    Finished(Result<(), TransportFailure>),
}

pub(crate) type WorkerSession = fn(HttpRequest, &WorkerContext) -> Result<(), TransportFailure>;

pub(crate) struct WorkerContext {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    connect_timeout: Duration,
    max_body_bytes: u64,
    tx: mpsc::SyncSender<TransferEvent>,
    #[cfg(any(test, feature = "test-hooks"))]
    extra_root_pem: Option<Vec<u8>>,
    #[cfg(any(test, feature = "test-hooks"))]
    hooks: TestTransferHooks,
}

pub(crate) struct WorkerResponse<'ctx> {
    response: Response,
    client: Client,
    final_url: Url,
    _ctx: PhantomData<&'ctx WorkerContext>,
}

impl WorkerResponse<'_> {
    pub(crate) fn status(&self) -> u16 {
        self.response.status().as_u16()
    }

    pub(crate) fn headers(&self) -> &HeaderMap {
        self.response.headers()
    }

    pub(crate) fn url(&self) -> &Url {
        &self.final_url
    }
}

pub(crate) struct RemoteTransfer {
    rx: Option<mpsc::Receiver<TransferEvent>>,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    finished: bool,
}

impl Drop for RemoteTransfer {
    fn drop(&mut self) {
        self.cancel_and_disconnect();
    }
}

impl RemoteTransfer {
    pub(crate) fn start(
        request: HttpRequest,
        limits: TransferLimits,
        session: WorkerSession,
    ) -> Result<Self, TransportFailure> {
        let deadline = limits.deadline;
        if Instant::now() >= deadline {
            return Err(TransportFailure::Timeout);
        }

        let (tx, rx) = mpsc::sync_channel::<TransferEvent>(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);

        #[cfg(any(test, feature = "test-hooks"))]
        if let Some(hook) = limits.hooks.worker_spawn_hook.as_ref() {
            hook();
        }

        let handle = thread::Builder::new()
            .name("clec-http-worker".to_owned())
            .spawn(move || run_worker(request, limits, worker_cancel, tx, session))
            .map_err(|_| TransportFailure::SpawnFailed)?;
        drop(handle);

        Ok(Self {
            rx: Some(rx),
            cancel,
            deadline,
            finished: false,
        })
    }

    pub(crate) fn recv_event(&mut self) -> Result<TransferEvent, TransportFailure> {
        if self.finished {
            return Err(TransportFailure::Disconnected);
        }
        let now = Instant::now();
        let Some(remaining) = self.deadline.checked_duration_since(now) else {
            self.cancel_and_disconnect();
            return Err(TransportFailure::Timeout);
        };
        if remaining.is_zero() {
            self.cancel_and_disconnect();
            return Err(TransportFailure::Timeout);
        }
        let Some(rx) = self.rx.as_ref() else {
            self.cancel_and_disconnect();
            return Err(TransportFailure::Timeout);
        };
        match rx.recv_timeout(remaining) {
            Ok(event) => {
                if Instant::now() >= self.deadline {
                    self.cancel_and_disconnect();
                    return Err(TransportFailure::Timeout);
                }
                if matches!(event, TransferEvent::Finished(_)) {
                    self.finished = true;
                }
                Ok(event)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.cancel_and_disconnect();
                Err(TransportFailure::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.cancel_and_disconnect();
                if Instant::now() >= self.deadline {
                    Err(TransportFailure::Timeout)
                } else {
                    Err(TransportFailure::Disconnected)
                }
            }
        }
    }

    fn cancel_and_disconnect(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.rx.take();
    }
}

impl WorkerContext {
    pub(crate) fn check_active(&self) -> Result<Duration, TransportFailure> {
        if self.cancel.load(Ordering::SeqCst) {
            return if Instant::now() >= self.deadline {
                Err(TransportFailure::Timeout)
            } else {
                Err(TransportFailure::Cancelled)
            };
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(TransportFailure::Timeout);
        }
        Ok(remaining)
    }

    pub(crate) fn send(
        &self,
        request: HttpRequest,
    ) -> Result<WorkerResponse<'_>, TransportFailure> {
        let url = match &request {
            HttpRequest::Get { url } | HttpRequest::Post { url, .. } => url.clone(),
        };
        validate_url_for_transport(&url)?;
        self.check_active()?;

        let pinned = resolve_and_pin_hop(
            &url,
            self,
            #[cfg(any(test, feature = "test-hooks"))]
            &self.hooks,
        )?;
        let remaining = self.check_active()?;
        let connect_timeout = self.connect_timeout.min(remaining);

        let client = build_hop_client(
            connect_timeout,
            pinned.as_ref(),
            #[cfg(any(test, feature = "test-hooks"))]
            self.extra_root_pem.as_deref(),
            #[cfg(any(test, feature = "test-hooks"))]
            &self.hooks,
        )?;
        let remaining = self.check_active()?;

        let builder = match request {
            HttpRequest::Get { url: req_url } => {
                client.get(req_url).header(ACCEPT_ENCODING, "identity")
            }
            HttpRequest::Post {
                url: req_url,
                mut headers,
                body,
            } => {
                headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
                client.post(req_url).headers(headers).body(body)
            }
        };

        let resp = builder
            .timeout(remaining)
            .send()
            .map_err(|err| classify_reqwest_send_err(&err, self))?;
        self.check_active()?;

        if let Some(remote_addr) = resp.remote_addr() {
            if url.scheme() == "http" && !remote_addr.ip().is_loopback() {
                return Err(TransportFailure::AddressPolicy(
                    AddressFailureReason::NonLoopbackHttp,
                ));
            }
            if let Some((_, addrs)) = pinned.as_ref()
                && !addrs.iter().any(|a| a.ip() == remote_addr.ip())
            {
                return Err(TransportFailure::AddressPolicy(
                    AddressFailureReason::UnpinnedRemote,
                ));
            }
        }

        Ok(WorkerResponse {
            response: resp,
            client,
            final_url: url,
            _ctx: PhantomData,
        })
    }

    pub(crate) fn stream(&self, response: WorkerResponse<'_>) -> Result<(), TransportFailure> {
        validate_response_encoding(response.headers())?;
        self.check_active()?;

        let status = response.status();
        let content_length = response.response.content_length();
        let WorkerResponse {
            client,
            mut response,
            final_url,
            ..
        } = response;

        if self
            .tx
            .send(TransferEvent::Head {
                final_url,
                status,
                content_length,
            })
            .is_err()
        {
            return Err(TransportFailure::Cancelled);
        }

        let mut buf = vec![0u8; STREAM_CHUNK_BYTES];
        let mut sent_bytes = 0u64;
        loop {
            self.check_active()?;
            let remaining_limit = self.max_body_bytes.saturating_sub(sent_bytes);
            if remaining_limit == 0 {
                break;
            }
            let to_read = (remaining_limit.min(buf.len() as u64)) as usize;
            let n = match response.read(&mut buf[..to_read]) {
                Ok(n) => n,
                Err(err) => return Err(classify_io_read_err(&err, self)),
            };
            if n == 0 {
                break;
            }
            self.check_active()?;
            sent_bytes = sent_bytes.saturating_add(n as u64);
            if self
                .tx
                .send(TransferEvent::Chunk(buf[..n].to_vec()))
                .is_err()
            {
                return Err(TransportFailure::Cancelled);
            }
            #[cfg(any(test, feature = "test-hooks"))]
            if let Some(counter) = self.hooks.chunks_sent_count.as_ref() {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        }

        drop(response);
        drop(client);
        Ok(())
    }
}

struct WorkerExitNotifier {
    #[cfg(any(test, feature = "test-hooks"))]
    hook: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Drop for WorkerExitNotifier {
    fn drop(&mut self) {
        #[cfg(any(test, feature = "test-hooks"))]
        if let Some(hook) = self.hook.take() {
            hook();
        }
    }
}

fn run_worker(
    request: HttpRequest,
    limits: TransferLimits,
    cancel: Arc<AtomicBool>,
    tx: mpsc::SyncSender<TransferEvent>,
    session: WorkerSession,
) {
    let _exit_guard = WorkerExitNotifier {
        #[cfg(any(test, feature = "test-hooks"))]
        hook: limits.hooks.worker_exit_hook.clone(),
    };

    #[cfg(any(test, feature = "test-hooks"))]
    let hooks = limits.hooks.clone();

    let ctx = WorkerContext {
        cancel,
        deadline: limits.deadline,
        connect_timeout: limits.connect_timeout,
        max_body_bytes: limits.max_body_bytes,
        tx,
        #[cfg(any(test, feature = "test-hooks"))]
        extra_root_pem: limits.extra_root_pem,
        #[cfg(any(test, feature = "test-hooks"))]
        hooks: limits.hooks,
    };

    let result = session(request, &ctx);

    #[cfg(any(test, feature = "test-hooks"))]
    if hooks.drop_before_finished {
        return;
    }

    #[cfg(any(test, feature = "test-hooks"))]
    if !ctx.cancel.load(Ordering::SeqCst)
        && let Some(hook) = hooks.pre_completion_cleanup_hook.as_ref()
    {
        hook();
    }

    let _ = ctx.tx.send(TransferEvent::Finished(result));
}

pub(crate) fn is_localhost_domain(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|h| h.eq_ignore_ascii_case("localhost"))
}

pub(crate) fn is_loopback_literal_host(host: &str) -> bool {
    if let Ok(v4) = host.parse::<Ipv4Addr>() {
        return v4.is_loopback();
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|s| s.strip_suffix(']'))
        && let Ok(v6) = inner.parse::<Ipv6Addr>()
    {
        return v6.is_loopback();
    }
    false
}

fn is_literal_ip_host(host: &str) -> bool {
    is_loopback_literal_host(host)
        || host.parse::<Ipv4Addr>().is_ok()
        || host
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .is_some_and(|inner| inner.parse::<Ipv6Addr>().is_ok())
}

fn validate_url_for_transport(url: &Url) -> Result<(), TransportFailure> {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(TransportFailure::AddressPolicy(
            AddressFailureReason::DisallowedUrl,
        ));
    }
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return Err(TransportFailure::Dns(DnsFailureReason::MissingHost));
    };
    match url.scheme() {
        "https" => Ok(()),
        "http" => {
            if is_localhost_domain(url) || is_loopback_literal_host(host) {
                Ok(())
            } else {
                Err(TransportFailure::AddressPolicy(
                    AddressFailureReason::NonLoopbackHttp,
                ))
            }
        }
        _ => Err(TransportFailure::AddressPolicy(
            AddressFailureReason::DisallowedUrl,
        )),
    }
}

fn system_resolve(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    Ok((host, port).to_socket_addrs()?.collect())
}

#[derive(Debug)]
struct ImmediateFailResolver;

impl reqwest::dns::Resolve for ImmediateFailResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(std::future::ready(Err(Box::new(io::Error::other(format!(
            "Unpinned DNS resolution refused for '{host}'"
        )))
            as Box<dyn std::error::Error + Send + Sync>)))
    }
}

fn resolve_host_for_worker(
    host: &str,
    port: u16,
    #[cfg(any(test, feature = "test-hooks"))] hooks: &TestTransferHooks,
) -> io::Result<Vec<SocketAddr>> {
    #[cfg(any(test, feature = "test-hooks"))]
    if let Some(hook) = hooks.resolve_hook.as_ref() {
        return hook(host, port);
    }
    system_resolve(host, port)
}

fn resolve_and_pin_hop(
    url: &Url,
    ctx: &WorkerContext,
    #[cfg(any(test, feature = "test-hooks"))] hooks: &TestTransferHooks,
) -> Result<Option<(String, Vec<SocketAddr>)>, TransportFailure> {
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return Err(TransportFailure::Dns(DnsFailureReason::MissingHost));
    };
    if is_literal_ip_host(host) {
        return Ok(None);
    }

    let default_port = if url.scheme() == "https" { 443 } else { 80 };
    let port = url.port_or_known_default().unwrap_or(default_port);
    let res = resolve_host_for_worker(
        host,
        port,
        #[cfg(any(test, feature = "test-hooks"))]
        hooks,
    );
    ctx.check_active()?;
    let addrs = res.map_err(|_| TransportFailure::Dns(DnsFailureReason::ResolveError))?;
    if addrs.is_empty() {
        return Err(TransportFailure::Dns(DnsFailureReason::EmptyAddresses));
    }
    if url.scheme() == "http" && !addrs.iter().all(|addr| addr.ip().is_loopback()) {
        return Err(TransportFailure::AddressPolicy(
            AddressFailureReason::NonLoopbackHttp,
        ));
    }
    Ok(Some((host.to_owned(), addrs)))
}

fn build_hop_client(
    connect_timeout: Duration,
    pinned: Option<&(String, Vec<SocketAddr>)>,
    #[cfg(any(test, feature = "test-hooks"))] extra_root_pem: Option<&[u8]>,
    #[cfg(any(test, feature = "test-hooks"))] hooks: &TestTransferHooks,
) -> Result<Client, TransportFailure> {
    let mut builder = ClientBuilder::new()
        .no_proxy()
        .dns_resolver(Arc::new(ImmediateFailResolver))
        .redirect(redirect::Policy::none())
        .retry(retry::never())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(connect_timeout)
        .user_agent(concat!("clec/", env!("CARGO_PKG_VERSION")));

    if let Some((domain, addrs)) = pinned {
        builder = builder.resolve_to_addrs(domain, addrs);
    }

    #[cfg(any(test, feature = "test-hooks"))]
    if let Some(pem) = extra_root_pem {
        let certs = reqwest::Certificate::from_pem_bundle(pem)
            .map_err(|_| TransportFailure::Setup(SetupFailureReason::InvalidFixtureCert))?;
        builder = builder.tls_certs_merge(certs);
    }

    #[cfg(any(test, feature = "test-hooks"))]
    if let Some(hook) = hooks.client_setup_hook.as_ref() {
        hook();
    }

    builder
        .build()
        .map_err(|_| TransportFailure::Setup(SetupFailureReason::ClientBuildFailed))
}

fn is_reqwest_timeout(err: &reqwest::Error) -> bool {
    if err.is_timeout() {
        return true;
    }
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        if let Some(io_err) = cause.downcast_ref::<io::Error>()
            && io_err.kind() == io::ErrorKind::TimedOut
        {
            return true;
        }
        if let Some(req_err) = cause.downcast_ref::<reqwest::Error>()
            && req_err.is_timeout()
        {
            return true;
        }
        source = cause.source();
    }
    false
}

fn classify_reqwest_send_err(err: &reqwest::Error, ctx: &WorkerContext) -> TransportFailure {
    if is_reqwest_timeout(err) || Instant::now() >= ctx.deadline {
        TransportFailure::Timeout
    } else if ctx.cancel.load(Ordering::SeqCst) {
        TransportFailure::Cancelled
    } else {
        TransportFailure::SendOrRead(SendReadFailureReason::SendFailed)
    }
}

fn classify_io_read_err(err: &io::Error, ctx: &WorkerContext) -> TransportFailure {
    let reqwest_timeout = err
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<reqwest::Error>())
        .is_some_and(is_reqwest_timeout);
    if err.kind() == io::ErrorKind::TimedOut || reqwest_timeout || Instant::now() >= ctx.deadline {
        TransportFailure::Timeout
    } else if ctx.cancel.load(Ordering::SeqCst) {
        TransportFailure::Cancelled
    } else {
        TransportFailure::SendOrRead(SendReadFailureReason::ReadFailed)
    }
}

fn validate_response_encoding(headers: &HeaderMap) -> Result<(), TransportFailure> {
    for val in headers.get_all(CONTENT_ENCODING) {
        let s = val
            .to_str()
            .map_err(|_| TransportFailure::Encoding(EncodingFailureReason::InvalidHeader))?;
        for part in s.split(',') {
            let trimmed = part.trim();
            if !trimmed.eq_ignore_ascii_case("identity") {
                return Err(TransportFailure::Encoding(
                    EncodingFailureReason::NonIdentity,
                ));
            }
        }
    }
    Ok(())
}

#[cfg(any(test, feature = "test-hooks"))]
pub(crate) type ResolveHookFn = Arc<dyn Fn(&str, u16) -> io::Result<Vec<SocketAddr>> + Send + Sync>;

#[cfg(any(test, feature = "test-hooks"))]
#[derive(Clone, Default)]
pub(crate) struct TestTransferHooks {
    pub resolve_hook: Option<ResolveHookFn>,
    pub client_setup_hook: Option<Arc<dyn Fn() + Send + Sync>>,
    pub pre_completion_cleanup_hook: Option<Arc<dyn Fn() + Send + Sync>>,
    pub worker_spawn_hook: Option<Arc<dyn Fn() + Send + Sync>>,
    pub worker_exit_hook: Option<Arc<dyn Fn() + Send + Sync>>,
    pub chunks_sent_count: Option<Arc<AtomicUsize>>,
    pub on_chunk_consumed: Option<Arc<dyn Fn(usize) + Send + Sync>>,
    pub drop_before_finished: bool,
}

#[cfg(any(test, feature = "test-hooks"))]
thread_local! {
    static ACTIVE_TEST_HOOKS: RefCell<Option<TestTransferHooks>> = const { RefCell::new(None) };
}

#[cfg(any(test, feature = "test-hooks"))]
pub(crate) struct TestHooksGuard {
    prev: Option<TestTransferHooks>,
}

#[cfg(any(test, feature = "test-hooks"))]
impl Drop for TestHooksGuard {
    fn drop(&mut self) {
        let prev = self.prev.take();
        ACTIVE_TEST_HOOKS.with(|slot| {
            *slot.borrow_mut() = prev;
        });
    }
}

#[cfg(any(test, feature = "test-hooks"))]
pub(crate) fn install_test_hooks_guard(hooks: TestTransferHooks) -> TestHooksGuard {
    let prev = ACTIVE_TEST_HOOKS.with(|slot| slot.borrow_mut().replace(hooks));
    TestHooksGuard { prev }
}

#[cfg(any(test, feature = "test-hooks"))]
pub(crate) fn current_test_hooks() -> TestTransferHooks {
    ACTIVE_TEST_HOOKS.with(|slot| slot.borrow().clone().unwrap_or_default())
}

#[cfg(test)]
pub(crate) fn system_resolve_for_test(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    system_resolve(host, port)
}

#[cfg(feature = "test-hooks")]
fn append_hook_log(path: Option<&Path>, line: &str) {
    if let Some(p) = path
        && let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p)
    {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(feature = "test-hooks")]
pub(crate) fn install_fixture_hooks_guard(
    resolver_delay_ms: Option<u64>,
    resolver_delay_host: Option<String>,
    setup_delay_ms: Option<u64>,
    cleanup_delay_ms: Option<u64>,
    hook_log_path: Option<PathBuf>,
) -> TestHooksGuard {
    let log_for_resolve = hook_log_path.clone();
    let resolve_hook: Option<ResolveHookFn> =
        if resolver_delay_ms.is_some() || log_for_resolve.is_some() {
            Some(Arc::new(move |host: &str, port: u16| {
                append_hook_log(
                    log_for_resolve.as_deref(),
                    &format!("resolve_enter:{host}:{port}"),
                );
                let host_matches = resolver_delay_host
                    .as_deref()
                    .is_none_or(|target| target.eq_ignore_ascii_case(host));
                if host_matches && let Some(ms) = resolver_delay_ms {
                    std::thread::sleep(Duration::from_millis(ms));
                }
                append_hook_log(
                    log_for_resolve.as_deref(),
                    &format!("resolve_exit:{host}:{port}"),
                );
                system_resolve(host, port)
            }))
        } else {
            None
        };

    let log_for_setup = hook_log_path.clone();
    let client_setup_hook: Option<Arc<dyn Fn() + Send + Sync>> =
        if setup_delay_ms.is_some() || log_for_setup.is_some() {
            Some(Arc::new(move || {
                append_hook_log(log_for_setup.as_deref(), "setup_enter");
                if let Some(ms) = setup_delay_ms {
                    std::thread::sleep(Duration::from_millis(ms));
                }
                append_hook_log(log_for_setup.as_deref(), "setup_exit");
            }))
        } else {
            None
        };

    let log_for_cleanup = hook_log_path.clone();
    let pre_completion_cleanup_hook: Option<Arc<dyn Fn() + Send + Sync>> =
        if cleanup_delay_ms.is_some() || log_for_cleanup.is_some() {
            Some(Arc::new(move || {
                append_hook_log(log_for_cleanup.as_deref(), "cleanup_enter");
                if let Some(ms) = cleanup_delay_ms {
                    std::thread::sleep(Duration::from_millis(ms));
                }
                append_hook_log(log_for_cleanup.as_deref(), "cleanup_exit");
            }))
        } else {
            None
        };

    let log_for_spawn = hook_log_path;
    let worker_spawn_hook: Option<Arc<dyn Fn() + Send + Sync>> = log_for_spawn.map(|p| {
        Arc::new(move || {
            append_hook_log(Some(&p), "worker_spawn");
        }) as Arc<dyn Fn() + Send + Sync>
    });

    install_test_hooks_guard(TestTransferHooks {
        resolve_hook,
        client_setup_hook,
        pre_completion_cleanup_hook,
        worker_spawn_hook,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Condvar, Mutex};

    struct Latch {
        entered: Mutex<usize>,
        entered_cv: Condvar,
        released: Mutex<bool>,
        released_cv: Condvar,
    }

    impl Latch {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                entered: Mutex::new(0),
                entered_cv: Condvar::new(),
                released: Mutex::new(false),
                released_cv: Condvar::new(),
            })
        }

        fn arrive_and_wait(&self, max_wait: Duration) {
            {
                let mut count = self.entered.lock().unwrap();
                *count += 1;
                self.entered_cv.notify_all();
            }
            let mut rel = self.released.lock().unwrap();
            let deadline = Instant::now() + max_wait;
            while !*rel {
                let rem = deadline.saturating_duration_since(Instant::now());
                if rem.is_zero() {
                    break;
                }
                let (guard, timeout_res) = self.released_cv.wait_timeout(rel, rem).unwrap();
                rel = guard;
                if timeout_res.timed_out() {
                    break;
                }
            }
        }

        fn wait_entered(&self, min_count: usize, timeout: Duration) -> bool {
            let mut count = self.entered.lock().unwrap();
            let deadline = Instant::now() + timeout;
            while *count < min_count {
                let rem = deadline.saturating_duration_since(Instant::now());
                if rem.is_zero() {
                    return false;
                }
                let (guard, timeout_res) = self.entered_cv.wait_timeout(count, rem).unwrap();
                count = guard;
                if timeout_res.timed_out() {
                    return *count >= min_count;
                }
            }
            true
        }

        fn release(&self) {
            let mut rel = self.released.lock().unwrap();
            *rel = true;
            self.released_cv.notify_all();
        }
    }

    fn post_once_session(
        request: HttpRequest,
        ctx: &WorkerContext,
    ) -> Result<(), TransportFailure> {
        let HttpRequest::Post { url, headers, body } = request else {
            return Err(TransportFailure::InvalidRequest);
        };
        let resp = ctx.send(HttpRequest::Post { url, headers, body })?;
        if resp.status() != 200 {
            return Err(TransportFailure::HttpStatus(resp.status()));
        }
        ctx.stream(resp)
    }

    #[test]
    fn post_session_sends_body_headers_and_streams_under_single_worker() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let cap_srv = Arc::clone(&captured);

        let srv = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut req_head = String::new();
            let mut content_len = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(val) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_len = val.trim().parse().unwrap_or(0);
                }
                req_head.push_str(&line);
            }
            let mut body = vec![0u8; content_len];
            reader.read_exact(&mut body).unwrap();
            *cap_srv.lock().unwrap() = format!("{req_head}{}", String::from_utf8_lossy(&body));
            let resp = b"{\"ok\":true}";
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", resp.len());
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(resp).unwrap();
            stream.flush().unwrap();
        });

        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let url = Url::parse(&format!("http://127.0.0.1:{}/decisions", addr.port())).unwrap();
        let mut transfer = RemoteTransfer::start(
            HttpRequest::Post {
                url,
                headers,
                body: br#"{"hello":"world"}"#.to_vec(),
            },
            TransferLimits {
                deadline: Instant::now() + Duration::from_secs(5),
                connect_timeout: Duration::from_secs(2),
                max_body_bytes: 1024,
                extra_root_pem: None,
                hooks: TestTransferHooks::default(),
            },
            post_once_session,
        )
        .unwrap();

        match transfer.recv_event().unwrap() {
            TransferEvent::Head { status, .. } => assert_eq!(status, 200),
            _ => panic!("expected Head"),
        }
        let mut body = Vec::new();
        loop {
            match transfer.recv_event().unwrap() {
                TransferEvent::Chunk(chunk) => body.extend_from_slice(&chunk),
                TransferEvent::Finished(Ok(())) => break,
                TransferEvent::Finished(Err(e)) => panic!("unexpected error: {e:?}"),
                TransferEvent::Head { .. } => panic!("duplicate Head"),
            }
        }
        assert_eq!(body, br#"{"ok":true}"#);
        srv.join().unwrap();
        let raw_req = captured.lock().unwrap();
        assert!(raw_req.starts_with("POST /decisions HTTP/1.1"));
        assert!(raw_req.contains(r#"{"hello":"world"}"#));
    }

    #[test]
    fn post_session_rejects_get_variant_and_enforces_cleanup_latch_deadline() {
        let err_transfer = RemoteTransfer::start(
            HttpRequest::Get {
                url: Url::parse("http://127.0.0.1:9/decisions").unwrap(),
            },
            TransferLimits {
                deadline: Instant::now() + Duration::from_secs(2),
                connect_timeout: Duration::from_secs(1),
                max_body_bytes: 1024,
                extra_root_pem: None,
                hooks: TestTransferHooks::default(),
            },
            post_once_session,
        )
        .unwrap();
        let mut t = err_transfer;
        assert_eq!(
            t.recv_event().map(|e| matches!(
                e,
                TransferEvent::Finished(Err(TransportFailure::InvalidRequest))
            )),
            Ok(true)
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut content_len = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(val) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_len = val.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; content_len];
            let _ = reader.read_exact(&mut body);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        });

        let latch = Latch::new();
        let l_cb = Arc::clone(&latch);
        let mut t2 = RemoteTransfer::start(
            HttpRequest::Post {
                url: Url::parse(&format!("http://127.0.0.1:{}/decisions", addr.port())).unwrap(),
                headers: HeaderMap::new(),
                body: b"{}".to_vec(),
            },
            TransferLimits {
                deadline: Instant::now() + Duration::from_millis(120),
                connect_timeout: Duration::from_secs(1),
                max_body_bytes: 1024,
                extra_root_pem: None,
                hooks: TestTransferHooks {
                    pre_completion_cleanup_hook: Some(Arc::new(move || {
                        l_cb.arrive_and_wait(Duration::from_millis(1500));
                    })),
                    ..Default::default()
                },
            },
            post_once_session,
        )
        .unwrap();

        assert!(matches!(
            t2.recv_event().unwrap(),
            TransferEvent::Head { .. }
        ));
        assert!(matches!(t2.recv_event().unwrap(), TransferEvent::Chunk(_)));
        let err = loop {
            match t2.recv_event() {
                Ok(TransferEvent::Chunk(_)) => continue,
                Err(e) => break e,
                Ok(TransferEvent::Finished(_)) => panic!("cleanup latch should force timeout"),
                Ok(TransferEvent::Head { .. }) => panic!("unexpected Head"),
            }
        };
        assert_eq!(err, TransportFailure::Timeout);
        assert!(latch.wait_entered(1, Duration::from_millis(500)));
        latch.release();
        srv.join().unwrap();
    }
}
