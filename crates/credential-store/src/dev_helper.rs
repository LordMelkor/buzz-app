use crate::{Error, Result};
use std::ffi::OsStr;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub(super) fn read(helper: &OsStr) -> Result<Zeroizing<Vec<u8>>> {
    if !Path::new(helper).is_absolute() {
        return Err(Error::Unavailable);
    }
    let authorize = std::env::var_os("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE").as_deref()
        == Some(OsStr::new("1"));
    let timeout = Duration::from_secs(if authorize { 120 } else { 5 });
    let deadline = Instant::now() + timeout;
    let (channel, helper_channel) = UnixStream::pair().map_err(|_| Error::Unavailable)?;
    let mut command = Command::new(helper);
    if authorize {
        command.arg("--authorize");
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(helper_channel)))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::Unavailable)?;
    // Command retains a socket copy. Close it so an exited helper produces EOF.
    drop(command);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Unavailable);
            }
        }
    };
    match status.code() {
        Some(0) => {}
        Some(10) => return Err(Error::Absent),
        Some(11) => return Err(Error::Denied),
        Some(12) => return Err(Error::Corrupt),
        _ => return Err(Error::Unavailable),
    }
    // The helper has exited. A retained socket in another process is a failure.
    channel
        .set_nonblocking(true)
        .map_err(|_| Error::Unavailable)?;
    let mut value = Zeroizing::new(Vec::with_capacity(64));
    channel
        .take(64)
        .read_to_end(&mut value)
        .map_err(|_| Error::Unavailable)?;
    if value.len() != 63 {
        return Err(Error::Corrupt);
    }
    Ok(value)
}
