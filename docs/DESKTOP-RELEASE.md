# Beaver Code Windows Release Operations

## Release boundary

Stable Windows releases are published from an exact canonical commit in
`qinghui316/beaver-code`. A `v<version>` tag starts the workflow. The protected
`windows-signing` GitHub Environment holds the production signing material used to create and
verify a draft. The separate `windows-release` Environment requires a human reviewer after that
exact draft exists and gates only final publication. Existing tags and Release assets are never
replaced.

The unpublished `v0.1.3` tag is retained as immutable failed-run evidence and is not a Release.
Beaver Code 0.1.6 is the first stable GitHub Release and the manual-install bootstrap for this
channel. A later patch release is the first end-to-end automatic-update proof. Windows Authenticode
is a later, independent gate; the 0.1.6 channel already requires the Ed25519 release signature
described below.

## One-time repository setup

1. Rename the GitHub repository to `qinghui316/beaver-code` only after the implementing Change has
   closed and its exact completion commit has received I2 Integration.
2. Update the local `origin`, then verify clone, fetch, push permissions, Issues, Actions, and the
   new Release URLs. Do not rely on the old repository redirect.
3. Create a protected GitHub Environment named `windows-signing`, restrict deployments to protected
   tags, add Environment secrets `BEAVER_UPDATE_SIGNING_PRIVATE_KEY` and
   `BEAVER_UPDATE_SIGNING_KEY_PASSWORD`, and add `BEAVER_UPDATE_SIGNING_KEY_ID` as an Environment
   variable.
4. Create a second protected Environment named `windows-release`, restrict it to protected tags,
   add a required reviewer, and set `BEAVER_RELEASE_ENABLED=true` there only after recovery and
   candidate-installation drills pass.
5. Keep signing credentials out of `windows-release`; the final publisher only re-downloads and
   independently verifies the already signed draft.
6. Enable GitHub private vulnerability reporting before directing users to the Security tab.

## Signing-key ceremony

The repository commits only `src/desktop/update-public-keys.json`. The matching private key is an
encrypted PKCS#8 Ed25519 key. Generate it on a trusted Windows account with two different locations:

```powershell
$env:BEAVER_UPDATE_KEY_BACKUP_DIR = 'X:\BeaverCode\update-signing-key'
$env:BEAVER_UPDATE_KEY_PASSWORD_FILE = "$env:USERPROFILE\.agent-harness\secrets\beaver-update-key-password.txt"
$env:BEAVER_UPDATE_SIGNING_KEY_ID = 'beaver-win-stable-2026-01'
npm run create:update-signing-key
```

The command refuses repository paths, refuses overwrites, and performs a sign-and-verify recovery
drill. Copy the encrypted private key to controlled offline storage and put the password in a
separate password manager. Remove the temporary password recovery file only after both GitHub
Environment secrets and the offline recovery method have been tested. Never paste either secret in
an issue, commit, build log, release note, or chat transcript.

Key rotation ships the new public key in an older trusted application before using the new private
key for releases. Keep at most two accepted keys during the overlap. Remove the old public key only
after the supported installed population can trust the new key. A lost key is not replaced under an
existing version or `keyId`.

## Publishing

1. Confirm the working tree is clean and the package version is a stable SemVer.
2. Run all repository, desktop-native, package, privacy, and update-manifest gates.
3. Confirm the canonical commit contains the intended public key and new-repository identity.
4. Create and push the exact `v<version>` tag.
5. Let `windows-signing` build and sign the update manifest, create the draft, re-download all seven
   assets from GitHub, and verify them independently.
6. Inspect that exact draft, then review and approve the `windows-release` Environment deployment;
   the publication job re-downloads and verifies it again before making it latest.
7. Verify the public Release contains exactly the installer, blockmap, `latest.yml`, signed manifest,
   signature, release receipt, and SHA-256 list.

The signed manifest is verified before JSON parsing. The client then checks stable SemVer, full
commit, platform, architecture, filenames, sizes, SHA-512, `latest.yml`, and exact repository URL.
Immediately before installation it re-reads the exact tagged Release and rechecks the cached
installer. The Workbench remains usable after download until the user chooses “重新启动并更新”.

## Withdrawal and recovery

For a bad release, remove it from `latest` and withdraw the Release immediately. Do not replace its
assets and do not automatically downgrade clients. Publish a corrected higher patch version from a
new canonical commit. A client that downloaded the withdrawn build will fail the pre-install exact
Release check and keep the current application running.

Update installation starts only after draft and Queue persistence, deterministic interruption of
active work, terminal/provider shutdown, and a valid Workbench receipt. Failure before teardown
cancels the installation and leaves the current version usable. Failure after teardown enters the
existing bounded recovery path; it never replays an uncertain provider request. Database migration
and per-project recovery remain owned by the persistence subsystem, not the updater.
