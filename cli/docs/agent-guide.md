# CLEC Agent Skill

The canonical agent workflow now lives in the distributable Skill at [../skills/clec/SKILL.md](../skills/clec/SKILL.md) (and inside consumer release archives at `skills/clec/SKILL.md`).

Keep normal model discovery enabled. Neither npm lifecycle scripts nor `clec` modify user-global Skill directories automatically.

To install the Skill for a host agent manually, copy `skills/clec/SKILL.md` into your host's Skill directory (for example, `$CODEX_HOME/skills/clec/SKILL.md`, `~/.pi/agent/skills/clec/SKILL.md`, or `~/.claude/skills/clec/SKILL.md`).

Run `clec schema` or `clec --help` to inspect the installed CLI contract directly.
