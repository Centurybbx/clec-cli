use std::{io, path::Path, sync::Arc};

use tantivy::directory::{
    Directory, DirectoryLock, FileHandle, Lock, META_LOCK, MmapDirectory, WatchCallback,
    WatchHandle, WritePtr,
    error::{DeleteError, LockError, OpenReadError, OpenWriteError},
};

#[derive(Clone, Debug)]
pub(crate) struct ReadOnlyDirectory(pub(crate) MmapDirectory);

fn immutable() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "immutable index snapshot")
}

impl Directory for ReadOnlyDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
        self.0.get_file_handle(path)
    }

    fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
        self.0.exists(path)
    }

    fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
        self.0.atomic_read(path)
    }

    fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
        Err(OpenWriteError::wrap_io_error(immutable(), path.into()))
    }

    fn delete(&self, path: &Path) -> Result<(), DeleteError> {
        Err(DeleteError::IoError {
            io_error: Arc::new(immutable()),
            filepath: path.into(),
        })
    }

    fn atomic_write(&self, _path: &Path, _data: &[u8]) -> io::Result<()> {
        Err(immutable())
    }

    fn sync_directory(&self) -> io::Result<()> {
        Err(immutable())
    }

    fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
        // Tantivy uses this lock to protect readers against a writer's garbage collection.
        // Snapshots are built into new paths and cannot have a concurrent writer.
        if lock.filepath == META_LOCK.filepath {
            Ok(DirectoryLock::from(Box::new(())))
        } else {
            Err(LockError::wrap_io_error(immutable()))
        }
    }

    fn watch(&self, _callback: WatchCallback) -> tantivy::Result<WatchHandle> {
        Err(immutable().into())
    }
}
