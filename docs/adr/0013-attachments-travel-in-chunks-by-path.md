# Attachments travel by path, and reach the Environment in chunks

Attachments were capped at 10 MiB. The cap was arbitrary, but the way a file travelled was not: the renderer read it whole and sent the bytes over IPC, and main sent it base64-encoded in one `files.write` request. Both ends cap a frame at 16 MiB, so nothing much above 12 MiB could go. The file was held in memory several times over, sent again at every delivery, and copied into `/tmp`, which is often RAM-backed and was never cleaned up (#296).

Attachments are now capped at 1 GiB, and travel like this:

- **The renderer sends a path, not bytes.** The preload exposes `webUtils.getPathForFile`. Only a file that has no path, such as a pasted image or a file dragged from a browser, is sent as bytes, under a 32 MiB cap. Main checks that the path is a regular file under the cap. The renderer is first-party and sandboxed, and the agent can already read local files, so main copying a path the renderer names gives nothing away.
- **Main streams the file into `userData`,** hashing it as it goes, so no file is ever held in memory whole.
- **The bridge takes a file in 1 MiB chunks** (`files.upload.begin`, `.chunk`, `.end`, `.abort`). The chunks are sent one at a time: requests are handled concurrently, so chunks sent together could arrive out of order, and a ping waiting behind megabytes of writes would get the bridge killed. `begin` answers `present` when a file of that size and hash is already there, so a file is not sent again at each delivery. Uploads still open are dropped when they sit idle and when the bridge stops.
- **A bridge on the same machine copies the file itself** (`files.copyTo`), with a copy-on-write clone where the filesystem allows. The bridge still does the copy, so main never touches an Environment's files (ADR 0008).
- **The copies go in the user's cache folder,** not the temp directory: `~/.cache/loom/attachments` (`~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows). The agent works freely there, as it does in the temp directory. The copies are removed when their Session is deleted (`files.remove`). This amends ADR 0008: Loom now keeps these copies in a distro too.
- **Only an image of 3.75 MiB or less goes to the agent inline** (about 5 MB in base64, which providers allow). A bigger one goes as a link to its copy, like any other file.

## Rejected

- **Raising the frame cap.** Every in-memory copy grows with the frame, and big frames hold up pings.
- **Writing through `\\wsl$`, or reading `/mnt/c` from the distro.** Either breaks ADR 0008, and `/mnt/c` relies on automount.
- **Hardlinks or symlinks to Loom's copy.** The agent could edit it, and the temp directory is often on another filesystem.
- **Pointing the agent at the user's original file.** History and queued messages need the file to stay as it was attached.
- **Appending chunks with `files.write`.** The bridge would have to read the whole file again to check its hash, and would leave partial files behind.
