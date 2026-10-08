use crate::text::revision_from_path;
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tempfile::{Builder, TempPath};

#[derive(Debug)]
pub enum Error {
    Known(String),
    Changed(Option<String>, String),
    #[cfg(windows)]
    Unknown(String),
}
fn known(action: &str, error: impl std::fmt::Display) -> Error {
    Error::Known(format!("{action}: {error}"))
}

struct Prepared {
    target: PathBuf,
    temp: Option<TempPath>,
}
impl Prepared {
    fn prepare(path: &Path, bytes: &[u8]) -> Result<Self, Error> {
        let target = fs::canonicalize(path).map_err(|e| known("resolve target", e))?;
        let metadata = fs::metadata(&target).map_err(|e| known("inspect target", e))?;
        if !metadata.is_file() {
            return Err(known(
                "refusing atomic write to non-regular file",
                target.display(),
            ));
        }
        let links =
            platform::links(&target, &metadata).map_err(|e| known("inspect hard links", e))?;
        if links > 1 {
            return Err(known(
                "refusing atomic write",
                format!(
                    "file has {links} hard links; preserving link identity would require a non-atomic in-place write"
                ),
            ));
        }
        let temporary = platform::temporary(&target, &metadata)
            .map_err(|e| known("create temporary sibling", e))?;
        let (mut file, temp) = temporary.into_parts();
        file.write_all(bytes)
            .map_err(|e| known("write temporary file", e))?;
        file.sync_all()
            .map_err(|e| known("synchronize temporary file", e))?;
        platform::close(file).map_err(|e| known("close temporary file", e))?;
        Ok(Self {
            target,
            temp: Some(temp),
        })
    }
    fn commit(self) -> Result<Option<String>, Error> {
        self.commit_using(platform::replace)
    }
    fn commit_using(
        self,
        replace: impl FnOnce(&Path, &Path) -> Result<Option<String>, Error>,
    ) -> Result<Option<String>, Error> {
        let result = replace(self.temp.as_ref().unwrap(), &self.target);
        #[cfg(windows)]
        if matches!(result, Err(Error::Unknown(_))) {
            let mut transaction = self;
            // [喵喵喵]: 未知结果中的候选可能携带唯一的附加流，禁止由 RAII 清理掉恢复材料。
            transaction.temp.as_mut().unwrap().disable_cleanup(true);
        }
        result
    }
}

pub fn atomic(path: &Path, bytes: &[u8], expected: &str) -> Result<Option<String>, Error> {
    let prepared = Prepared::prepare(path, bytes)?;
    match revision_from_path(&prepared.target) {
        Ok(current) if current == expected => prepared.commit(),
        Ok(current) => Err(Error::Changed(
            Some(current.clone()),
            format!("source changed before commit: expected {expected}, current {current}"),
        )),
        Err(error) => Err(Error::Changed(
            None,
            format!("source changed before commit: re-read current target: {error}"),
        )),
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, IntoRawHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::*,
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    pub fn links(path: &Path, _: &fs::Metadata) -> io::Result<u64> {
        let file = File::open(path)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info.nNumberOfLinks as u64)
    }
    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    fn dacl_only_descriptor(source: &Descriptor) -> io::Result<SECURITY_DESCRIPTOR> {
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        let mut control = 0;
        let mut revision = 0;
        if unsafe {
            GetSecurityDescriptorDacl(source.0, &mut present, &mut dacl, &mut defaulted) == 0
                || GetSecurityDescriptorControl(source.0, &mut control, &mut revision) == 0
        } {
            return Err(io::Error::last_os_error());
        }
        // [喵喵喵]: DACL-only 查询仍可能附带 Owner/Group；不能把它们用于创建，否则普通令牌可能触发 1307。
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let pointer = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
        let inheritance = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ;
        if unsafe {
            InitializeSecurityDescriptor(pointer, revision) == 0
                || SetSecurityDescriptorDacl(pointer, present, dacl, defaulted) == 0
                || SetSecurityDescriptorControl(pointer, inheritance, control & inheritance) == 0
        } {
            return Err(io::Error::last_os_error());
        }
        Ok(descriptor)
    }
    pub fn temporary(
        target: &Path,
        metadata: &fs::Metadata,
    ) -> io::Result<tempfile::NamedTempFile> {
        if metadata.permissions().readonly() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "target is read-only",
            ));
        }
        let mut descriptor = null_mut();
        let code = unsafe {
            GetNamedSecurityInfoW(
                wide(target).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if code != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let descriptor = Descriptor(descriptor);
        // [喵喵喵]: creation 只借用 descriptor 中的 DACL 内存，两者均须存续至 CreateFileW 完成。
        let mut creation = dacl_only_descriptor(&descriptor)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut creation as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: 0,
        };
        // [喵喵喵]: 创建时即传入目标 DACL，正文落盘前不暴露宽权限窗口；不能先创建再收紧 ACL。
        Builder::new()
            .prefix(".hledit-")
            .make_in(target.parent().unwrap(), |path| {
                let handle = unsafe {
                    CreateFileW(
                        wide(path).as_ptr(),
                        GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        &attributes,
                        CREATE_NEW,
                        FILE_ATTRIBUTE_NORMAL,
                        null_mut(),
                    )
                };
                if handle == INVALID_HANDLE_VALUE {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(unsafe { File::from_raw_handle(handle) })
                }
            })
    }
    pub fn close(file: File) -> io::Result<()> {
        if unsafe { CloseHandle(file.into_raw_handle()) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn move_without_replace(from: &Path, to: &Path) -> io::Result<()> {
        if unsafe {
            MoveFileExW(
                wide(from).as_ptr(),
                wide(to).as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn call_replace(target: &Path, candidate: &Path, backup: &Path) -> io::Result<()> {
        // [喵喵喵]: flags=0 要求 DACL/ADS 合并成功，不以忽略元数据错误换取表面成功。
        if unsafe {
            ReplaceFileW(
                wide(target).as_ptr(),
                wide(candidate).as_ptr(),
                wide(backup).as_ptr(),
                0,
                null(),
                null(),
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn unknown(
        target: &Path,
        candidate: &Path,
        backup: &Path,
        error: impl std::fmt::Display,
    ) -> Error {
        Error::Unknown(format!(
            "write outcome unknown: {error}; inspect target {:?}, replacement candidate {:?}, and original recovery file {:?} before editing; recovery files were retained",
            target, candidate, backup
        ))
    }
    fn settle(target: &Path, candidate: &Path, backup: &Path, error: io::Error) -> Error {
        if error.raw_os_error().is_none() {
            return unknown(target, candidate, backup, error);
        }
        if error.raw_os_error() == Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 as i32) {
            // [喵喵喵]: 1177 已把原文件移到 backup；只能无覆盖地移回，遇到他人新建目标必须保留材料。
            return match move_without_replace(backup, target) {
                Ok(()) => known(
                    "replace target",
                    format!("{error}; the original file was restored unchanged"),
                ),
                Err(restore) => unknown(
                    target,
                    candidate,
                    backup,
                    format!("{error}; restoring the original file failed: {restore}"),
                ),
            };
        }
        if let Err(stat) = fs::symlink_metadata(target) {
            return unknown(
                target,
                candidate,
                backup,
                format!(
                    "{error}; target could not be confirmed after the failed replacement: {stat}"
                ),
            );
        }
        if let Err(cleanup) = fs::remove_file(backup)
            && cleanup.kind() != io::ErrorKind::NotFound
        {
            return known(
                "replace target",
                format!("{error}; recovery file {backup:?} could not be removed: {cleanup}"),
            );
        }
        known("replace target", error)
    }
    fn replace_with(
        candidate: &Path,
        target: &Path,
        call: impl FnOnce(&Path, &Path, &Path) -> io::Result<()>,
    ) -> Result<Option<String>, Error> {
        let backup = Builder::new()
            .prefix(".hledit-backup-")
            .tempfile_in(target.parent().unwrap())
            .map_err(|e| known("reserve recovery file", e))?;
        let (file, path) = backup.into_parts();
        close(file).map_err(|e| known("close recovery file", e))?;
        let backup = path.keep().map_err(|e| known("retain recovery file", e))?;
        if let Err(error) = call(target, candidate, &backup) {
            return Err(settle(target, candidate, &backup, error));
        }
        match fs::remove_file(&backup) {
            Ok(()) => Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Ok(Some(format!(
                "file was replaced, but original recovery file {backup:?} could not be removed: {error}"
            ))),
        }
    }
    pub fn replace(candidate: &Path, target: &Path) -> Result<Option<String>, Error> {
        replace_with(candidate, target, call_replace)
    }

    #[cfg(test)]
    mod tests;
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    pub fn links(_: &Path, metadata: &fs::Metadata) -> io::Result<u64> {
        Ok(metadata.nlink())
    }
    pub fn temporary(
        target: &Path,
        metadata: &fs::Metadata,
    ) -> io::Result<tempfile::NamedTempFile> {
        let temporary =
            Builder::new()
                .prefix(".hledit-")
                .make_in(target.parent().unwrap(), |path| {
                    fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(path)
                })?;
        temporary
            .as_file()
            .set_permissions(metadata.permissions())?;
        Ok(temporary)
    }
    pub fn close(file: File) -> io::Result<()> {
        drop(file);
        Ok(())
    }
    pub fn replace(candidate: &Path, target: &Path) -> Result<Option<String>, Error> {
        fs::rename(candidate, target).map_err(|e| known("replace target", e))?;
        match File::open(target.parent().unwrap()).and_then(|f| f.sync_all()) {
            Ok(()) => Ok(None),
            Err(error) => Ok(Some(format!(
                "file was replaced, but directory metadata could not be synchronized: {error}"
            ))),
        }
    }
}

#[cfg(not(any(windows, unix)))]
compile_error!("hledit requires Windows or Unix atomic replacement semantics");
