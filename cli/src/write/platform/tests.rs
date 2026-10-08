use super::*;
use crate::text::revision;

fn dacl(path: &Path) -> String {
    let mut descriptor = null_mut();
    assert_eq!(
        unsafe {
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        },
        ERROR_SUCCESS
    );
    let descriptor = Descriptor(descriptor);
    let mut output = null_mut();
    let mut length = 0;
    assert_ne!(
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor.0,
                1,
                DACL_SECURITY_INFORMATION,
                &mut output,
                &mut length,
            )
        },
        0
    );
    // [喵喵喵]: length 是缓冲区容量，不是文本长度；按首个 NUL 截断，避免比较分配余量。
    let mut end = 0;
    while end < length as usize && unsafe { *output.add(end) } != 0 {
        end += 1;
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(output, end) });
    unsafe {
        LocalFree(output.cast());
    }
    result
}
fn restrict(path: &Path) {
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)".encode_utf16().chain(Some(0)).collect();
    let mut descriptor = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        },
        0
    );
    let descriptor = Descriptor(descriptor);
    let mut acl = null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    assert_ne!(
        unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) },
        0
    );
    assert_eq!(
        unsafe {
            SetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        },
        ERROR_SUCCESS
    );
}
// [喵喵喵]: Windows 可规范化 AI/AR 标记；仍完整比较保护位与每条 ACE（包括继承标志）。
fn comparable(dacl: &str) -> String {
    match dacl.find('(') {
        Some(index) => format!(
            "{}{}",
            if dacl[..index].contains('P') {
                "D:P"
            } else {
                "D:"
            },
            &dacl[index..]
        ),
        None => dacl.to_owned(),
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.txt");
    fs::write(&target, "old").unwrap();
    (dir, target)
}
fn only_target(dir: &Path) {
    assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
}
fn lock(path: &Path) -> File {
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    assert_ne!(handle, INVALID_HANDLE_VALUE);
    unsafe { File::from_raw_handle(handle) }
}

#[test]
fn creation_descriptor_omits_owner_and_group_without_changing_dacl() {
    for (flags, inheritance) in [
        ("", 0),
        (
            "PAIAR",
            SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ,
        ),
    ] {
        let sddl: Vec<u16> = format!("O:BAG:BAD:{flags}(A;;FA;;;AU)")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut source = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut source,
                    null_mut(),
                )
            },
            0
        );
        let source = Descriptor(source);
        let mut creation = dacl_only_descriptor(&source).unwrap();
        assert!(creation.Owner.is_null());
        assert!(creation.Group.is_null());
        assert!(creation.Sacl.is_null());
        assert_eq!(creation.Control, SE_DACL_PRESENT | inheritance);
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        assert_ne!(
            unsafe { GetSecurityDescriptorDacl(source.0, &mut present, &mut dacl, &mut defaulted) },
            0
        );
        assert_ne!(present, 0);
        assert!(!dacl.is_null());
        assert_eq!(creation.Dacl, dacl);

        // [喵喵喵]: 不仅检查描述符字段；实际创建可验证普通令牌不再因原 Owner/Group 被拒绝。
        let dir = tempfile::tempdir().unwrap();
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut creation as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: 0,
        };
        let handle = unsafe {
            CreateFileW(
                wide(&dir.path().join("candidate.txt")).as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        assert_ne!(
            handle,
            INVALID_HANDLE_VALUE,
            "{}",
            io::Error::last_os_error()
        );
        drop(unsafe { File::from_raw_handle(handle) });
    }
}

#[test]
fn preserves_target_and_temporary_dacl_and_ads() {
    for protected in [false, true] {
        let (dir, target) = fixture();
        if protected {
            restrict(&target);
        }
        let before = dacl(&target);
        let stream = PathBuf::from(format!("{}:reviewData", target.display()));
        fs::write(&stream, "sentinel").unwrap();
        let prepared = Prepared::prepare(&target, b"new").unwrap();
        assert_eq!(
            comparable(&dacl(prepared.temp.as_ref().unwrap())),
            comparable(&before)
        );
        prepared.commit().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(comparable(&dacl(&target)), comparable(&before));
        assert_eq!(fs::read(stream).unwrap(), b"sentinel");
        only_target(dir.path());
    }
}

#[test]
fn partial_failure_restores_without_overwriting_and_retains_unknown_materials() {
    for occupied in [false, true] {
        let (dir, target) = fixture();
        let prepared = Prepared::prepare(&target, b"new").unwrap();
        let candidate = prepared.temp.as_ref().unwrap().to_path_buf();
        let mut backup_path = PathBuf::new();
        let result = prepared.commit_using(|candidate, target| {
            replace_with(candidate, target, |target, candidate, backup| {
                backup_path = backup.to_path_buf();
                fs::rename(target, backup)?;
                fs::write(format!("{}:reviewData", candidate.display()), "sentinel")?;
                if occupied {
                    fs::write(target, "other process")?;
                }
                Err(io::Error::from_raw_os_error(
                    ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 as i32,
                ))
            })
        });
        if occupied {
            let Err(Error::Unknown(message)) = result else {
                panic!("expected unknown outcome: {result:?}")
            };
            assert!(message.contains("recovery files were retained"));
            assert_eq!(fs::read(&target).unwrap(), b"other process");
            assert_eq!(fs::read(&candidate).unwrap(), b"new");
            assert_eq!(fs::read(backup_path).unwrap(), b"old");
            assert_eq!(
                fs::read(format!("{}:reviewData", candidate.display())).unwrap(),
                b"sentinel"
            );
        } else {
            let Err(Error::Known(message)) = result else {
                panic!("expected restored rejection: {result:?}")
            };
            assert!(message.contains("original file was restored unchanged"));
            assert_eq!(fs::read(&target).unwrap(), b"old");
            only_target(dir.path());
        }
    }
}

#[test]
fn undocumented_failure_with_missing_target_retains_both_files() {
    let (_dir, target) = fixture();
    let prepared = Prepared::prepare(&target, b"new").unwrap();
    let candidate = prepared.temp.as_ref().unwrap().to_path_buf();
    let mut backup_path = PathBuf::new();
    let result = prepared.commit_using(|candidate, target| {
        replace_with(candidate, target, |target, _, backup| {
            backup_path = backup.to_path_buf();
            fs::rename(target, backup)?;
            Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32))
        })
    });
    assert!(matches!(result, Err(Error::Unknown(_))));
    assert_eq!(fs::read(backup_path).unwrap(), b"old");
    assert_eq!(fs::read(candidate).unwrap(), b"new");
}

#[test]
fn known_replacement_failures_clean_only_owned_files() {
    for code in [
        ERROR_UNABLE_TO_REMOVE_REPLACED,
        ERROR_UNABLE_TO_MOVE_REPLACEMENT,
        ERROR_ACCESS_DENIED,
    ] {
        let (dir, target) = fixture();
        let untouched = dir.path().join(".hledit-user-owned");
        fs::write(&untouched, "untouched").unwrap();
        let result =
            Prepared::prepare(&target, b"new")
                .unwrap()
                .commit_using(|candidate, target| {
                    replace_with(candidate, target, |_, _, _| {
                        Err(io::Error::from_raw_os_error(code as i32))
                    })
                });
        assert!(matches!(result, Err(Error::Known(_))));
        assert_eq!(fs::read(target).unwrap(), b"old");
        assert_eq!(fs::read(untouched).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}

#[test]
fn cleanup_failure_reports_success_with_recovery_path() {
    let (_dir, target) = fixture();
    let mut backup_path = PathBuf::new();
    let mut locked = None;
    let result = Prepared::prepare(&target, b"new")
        .unwrap()
        .commit_using(|candidate, target| {
            replace_with(candidate, target, |target, candidate, backup| {
                call_replace(target, candidate, backup)?;
                backup_path = backup.to_path_buf();
                locked = Some(lock(backup));
                Ok(())
            })
        })
        .unwrap()
        .unwrap();
    assert!(result.starts_with("file was replaced, but original recovery file "));
    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert_eq!(fs::read(backup_path).unwrap(), b"old");
    drop(locked);
}

#[test]
fn sharing_readonly_hardlink_and_revision_changes_are_zero_write() {
    let (dir, target) = fixture();
    let locked = lock(&target);
    assert!(matches!(
        atomic(&target, b"new", &revision(b"old")),
        Err(Error::Known(_))
    ));
    drop(locked);
    let original_permissions = fs::metadata(&target).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&target, readonly).unwrap();
    assert!(matches!(
        atomic(&target, b"new", &revision(b"old")),
        Err(Error::Known(_))
    ));
    fs::set_permissions(&target, original_permissions).unwrap();
    let link = dir.path().join("link.txt");
    fs::hard_link(&target, &link).unwrap();
    assert!(matches!(
        atomic(&target, b"new", &revision(b"old")),
        Err(Error::Known(_))
    ));
    fs::remove_file(link).unwrap();
    assert!(matches!(
        atomic(&target, b"new", &revision(b"different")),
        Err(Error::Changed(Some(_), _))
    ));
    assert_eq!(fs::read(&target).unwrap(), b"old");
    only_target(dir.path());
}
