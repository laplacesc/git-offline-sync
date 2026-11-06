use std::path::Path;

use git_offline_sync_lib::core::{
    error::{Result, SyncError},
    git::Git,
    manifest::Manifest,
    repo,
    sync::{self, ImportConfirmation},
};

/// Simulate a fresh UI scan. Stale-confirmation tests keep this value and mutate
/// the source or mirror before calling the real core entry point.
pub fn confirmation(
    g: &Git,
    bundle: &Path,
    mirror: &Path,
    allow_full_gap: bool,
) -> Result<ImportConfirmation> {
    Ok(ImportConfirmation {
        manifest: Manifest::read_for(bundle)?
            .ok_or_else(|| SyncError::Invalid("test package needs a manifest".into()))?,
        last_in_seq: repo::load_state::<repo::MirrorState>(mirror)?.last_in_seq,
        mirror_refs: if repo::is_ext_mirror(g, mirror) {
            repo::list_refs(g, mirror, &["refs/heads", "refs/tags"])?
                .into_iter()
                .collect()
        } else {
            Default::default()
        },
        allow_full_gap,
    })
}

pub fn import_confirmed(g: &Git, bundle: &Path, mirror: &Path, allow_full_gap: bool) -> Result<()> {
    let confirmation = confirmation(g, bundle, mirror, allow_full_gap)?;
    sync::import_in(g, bundle, mirror, Some(&confirmation))
}
