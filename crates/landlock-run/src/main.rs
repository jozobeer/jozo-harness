//! Confines writes with Landlock, then execs the command it was given.
//!
//! The sandbox provider runs this when bubblewrap cannot create the user
//! namespace it needs, so the boundary comes from the kernel rather than from a
//! mount namespace. Reads stay open: only the write rights are handled, and each
//! root the caller names gets one rule. A root that does not exist is skipped,
//! which matches bwrap's `--bind-try`.

use std::process::ExitCode;

#[cfg(target_os = "linux")]
fn main() -> ExitCode {
    linux::main()
}

/// The provider only probes on Linux, but the workspace checks this crate on
/// macOS too, where the binary must still build and say why it cannot run.
#[cfg(not(target_os = "linux"))]
fn main() -> ExitCode {
    eprintln!("landlock-run: Landlock only exists on Linux; this platform has its own sandbox");
    ExitCode::from(3)
}

#[cfg(target_os = "linux")]
mod linux {
    use landlock::{
        ABI, AccessFs, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
        RulesetAttr, RulesetCreatedAttr, RulesetStatus,
    };
    use std::ffi::OsString;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitCode};

    /// The device a command redirects output to, which stays writable the way
    /// seatbelt's profile and bwrap's fresh /dev keep it.
    const DEV_NULL: &str = "/dev/null";

    const EXIT_USAGE: u8 = 2;
    const EXIT_LANDLOCK: u8 = 3;
    const EXIT_EXEC: u8 = 127;

    enum Invocation {
        /// Applies the ruleset with nothing writable but /dev/null and exits.
        Probe,
        Run {
            roots: Vec<PathBuf>,
            argv: Vec<OsString>,
        },
    }

    pub fn main() -> ExitCode {
        match parse(std::env::args_os().skip(1)) {
            Ok(Invocation::Probe) => report(confine(&[])),
            Ok(Invocation::Run { roots, argv }) => match confine(&roots) {
                Ok(()) => exec(&argv),
                Err(reason) => {
                    eprintln!("landlock-run: {reason}");
                    ExitCode::from(EXIT_LANDLOCK)
                }
            },
            Err(reason) => {
                eprintln!("landlock-run: {reason}");
                eprintln!(
                    "usage: landlock-run [--probe | --writable-root PATH ... -- COMMAND [ARG ...]]"
                );
                ExitCode::from(EXIT_USAGE)
            }
        }
    }

    fn report(result: Result<(), String>) -> ExitCode {
        match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(reason) => {
                eprintln!("landlock-run: {reason}");
                ExitCode::from(EXIT_LANDLOCK)
            }
        }
    }

    fn parse(args: impl Iterator<Item = OsString>) -> Result<Invocation, String> {
        let mut roots = Vec::new();
        let mut probe = false;
        let mut args = args;
        while let Some(arg) = args.next() {
            if arg == "--probe" {
                probe = true;
            } else if arg == "--writable-root" {
                let root = args.next().ok_or("--writable-root needs a path")?;
                roots.push(PathBuf::from(root));
            } else if arg == "--" {
                let argv: Vec<OsString> = args.collect();
                if probe {
                    return Err("--probe takes no command".into());
                }
                if argv.is_empty() {
                    return Err("missing the command after --".into());
                }
                return Ok(Invocation::Run { roots, argv });
            } else {
                return Err(format!("unknown argument {arg:?}"));
            }
        }
        if probe && roots.is_empty() {
            return Ok(Invocation::Probe);
        }
        Err("missing -- before the command".into())
    }

    /// Applies one ruleset to this process. Landlock has no way to describe a
    /// hierarchy from the outside, so every writable root becomes a path-beneath
    /// rule.
    ///
    /// ABI 3 is the newest level whose write set holds only filesystem writes. ABI 5
    /// adds IoctlDev and ABI 9 ResolveUnix, which would also constrain a command's
    /// terminal and its unix-socket lookups; leaving those unhandled keeps ioctls
    /// and the network as open as the bwrap profile leaves them.
    ///
    /// The handled set is a hard requirement. The crate's default is best-effort,
    /// which on a kernel older than 6.2 drops `truncate` and still returns a
    /// ruleset. `truncate(2)` is not covered by the write-file right, so that
    /// ruleset empties any file the user may write while ordinary opens stay
    /// denied. A kernel that cannot enforce the whole set must fail the probe.
    fn confine(roots: &[PathBuf]) -> Result<(), String> {
        let access = AccessFs::from_write(ABI::V3);
        let mut ruleset = Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(access)
            .map_err(|error| format!("cannot build the ruleset: {error}"))?
            .create()
            .map_err(|error| format!("cannot create the ruleset: {error}"))?;
        for root in writable_paths(roots) {
            if !root.exists() {
                continue;
            }
            let allowed = access_for(&root, access)?;
            let fd = PathFd::new(&root)
                .map_err(|error| format!("cannot open {}: {error}", root.display()))?;
            ruleset = ruleset
                .add_rule(PathBeneath::new(fd, allowed))
                .map_err(|error| format!("cannot add a rule for {}: {error}", root.display()))?;
        }
        let status = ruleset
            .restrict_self()
            .map_err(|error| format!("cannot apply the ruleset: {error}"))?;
        // Hard requirement already rejects a downgraded handled set. This is the
        // check that the kernel applied every right that set named.
        if status.ruleset != RulesetStatus::FullyEnforced {
            return Err(
                "the kernel does not enforce the full Landlock write set, including truncate"
                    .into(),
            );
        }
        Ok(())
    }

    /// Directory-only rights are rejected on a file. The ruleset requires every
    /// right it asks for, so a file such as /dev/null keeps only the write
    /// rights that apply to one; otherwise the probe would fail.
    fn access_for(path: &Path, access: BitFlags<AccessFs>) -> Result<BitFlags<AccessFs>, String> {
        let info = std::fs::metadata(path)
            .map_err(|error| format!("cannot stat {}: {error}", path.display()))?;
        let allowed = if info.is_dir() {
            access
        } else {
            access & (AccessFs::WriteFile | AccessFs::Truncate)
        };
        Ok(allowed)
    }

    fn writable_paths(roots: &[PathBuf]) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = roots.to_vec();
        paths.push(Path::new(DEV_NULL).to_path_buf());
        paths
    }

    fn exec(argv: &[OsString]) -> ExitCode {
        let Some((program, args)) = argv.split_first() else {
            return ExitCode::from(EXIT_USAGE);
        };
        let error = Command::new(program).args(args).exec();
        eprintln!("landlock-run: cannot exec {program:?}: {error}");
        ExitCode::from(EXIT_EXEC)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_file_rule_keeps_truncate_and_drops_directory_rights() {
            let access = AccessFs::from_write(ABI::V3);
            let allowed = access_for(Path::new("/dev/null"), access).unwrap();

            assert!(allowed.contains(AccessFs::WriteFile));
            assert!(allowed.contains(AccessFs::Truncate));
            assert!(!allowed.contains(AccessFs::MakeReg));
            assert!(!allowed.contains(AccessFs::Refer));
        }

        #[test]
        fn a_directory_rule_keeps_the_full_write_set() {
            let access = AccessFs::from_write(ABI::V3);
            let allowed = access_for(Path::new("/tmp"), access).unwrap();

            assert_eq!(allowed, access);
        }
    }
}
