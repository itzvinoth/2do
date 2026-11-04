# 2do

A simple, offline-first todo app. Plain HTML/CSS/JS with no frontend framework, styled with [Oat UI](https://oat.ink).
It runs as a Linux desktop app or as an installable PWA.

- Categories: create as many as you need (Personal, Project X, …)
- Priorities (high, medium, low) and due dates
- Finished tasks move to the Archive, grouped by the day they were finished. You can reopen them
- Import and export everything as a Markdown (`.md`) file

## Requirements

| To | You need |
|---|---|
| Run | Any 64-bit Linux distro. A Chromium-based browser (Chrome, Chromium, Brave, Edge or Vivaldi) gives you a standalone app window. Without one, 2do opens in your default browser. |
| Build | [Go](https://go.dev/dl/) 1.24 or newer, and `make` |

The built binary is fully static. It has no runtime dependencies, so it doesn't need GTK, WebKit or Node.

## Install (this laptop)

```sh
make install
```

This builds `./2do` and installs it for your user only, without root:

- `~/.local/bin/2do`: the program
- `~/.local/share/applications/2do.desktop`: the launcher entry (search "2do" in your app menu)
- `~/.local/share/icons/hicolor/scalable/apps/2do.svg`: the icon

Start it from the app menu or by running `2do`. Closing the window quits the app.

To remove it, run `make uninstall`. This keeps your data. To delete your data too, remove `~/.local/share/2do`
(and `~/.config/2do`, which holds the app window's browser profile).

## Use it on other laptops

### 1. Get the program onto the other laptop

**Option A: build there.** Copy this project folder (or clone it), then run `make install`.

**Option B: copy the binary.** The other laptop doesn't need Go. Build on this laptop:

```sh
make build                           # for x86_64 laptops
GOARCH=arm64 make build              # for ARM laptops (check with `uname -m` on the target)
```

Then copy these three files to the other laptop: `2do`, `packaging/2do.desktop` and `web/icons/icon.svg`. On the other
laptop, from the folder you copied them to, run:

```sh
install -Dm755 2do ~/.local/bin/2do
install -Dm644 icon.svg ~/.local/share/icons/hicolor/scalable/apps/2do.svg
install -Dm644 2do.desktop ~/.local/share/applications/2do.desktop
sed -i "s|^Exec=.*|Exec=$HOME/.local/bin/2do|" ~/.local/share/applications/2do.desktop
```

### 2. Bring your tasks along

Use either of these:

- **Markdown:** on the old laptop, click the export icon (top right) to save a `.md` file. On the new laptop, click
  the import icon, pick that file and choose **Replace** (or **Merge** to add to what's already there).
- **Data file:** close 2do on both laptops, then copy `~/.local/share/2do/data.json` from the old laptop to the same
  place on the new one. This keeps everything exactly, including the archive history.

There is no built-in sync. If you keep `data.json` in a synced folder (for example with Syncthing or Nextcloud,
through a symlink), only run 2do on one laptop at a time. Otherwise the last laptop to save overwrites the other's
changes.

### 3. Or use it as a PWA (any device)

The `web/` folder is a self-contained static site. Serve it over HTTPS from any static host your organisation approves,
open it in Chrome or Edge, and choose **Install app** in the address bar. It then works offline. In this mode, your
tasks are stored in that browser's local storage, separate from the desktop app's data file, so export to `.md` now
and then as a backup.

## How to use

**Adding tasks.** Open a category (or **All tasks**), type in **Add a task** below the list and press **Enter**. The
input stays focused, so you can type the next task right away. While you type, small chips appear on the right for
optional settings:

- the calendar chip sets a due date
- the flag chip sets the priority (low by default)
- the tag chip, in **All tasks** only, picks the category

Press **Esc** to clear the input.

**Working with tasks.** Hover over a task to see its controls.

| Action | How |
|---|---|
| Rename | Click the title, edit it, then press Enter (or Esc to cancel) |
| Change priority | Click the flag. Red is high, amber is medium, and low shows no flag |
| Change due date | Click the date. Overdue dates turn red and today's turn amber. Use the picker's *Clear* to remove a date |
| Notes, or move to another category | Pencil icon |
| Delete | Trash icon |

Tasks are sorted by priority, then by due date.

**Finishing and reopening.** Tick the checkbox to finish a task. It moves to the **Archive**, and the snackbar offers
**Undo**. The archive groups tasks by the day you finished them (Today, Yesterday, then dates). Hover over a title to
see the exact finish, creation and due times. Use the reopen icon to bring a task back. Click **N finished** under a
category's list to see that category's archive.

**Categories.** Type a name in **New category** in the sidebar and press Enter. To rename or delete a category, open
it and use the ⋮ menu. Deleting a category also deletes its tasks.

**Import and export.** These are the two icons at the top right.

## Markdown format

```md
## Personal

- [ ] Buy milk `priority:high` `due:2026-11-10`
  > Notes go on indented, quoted lines.
- [x] Pay rent `priority:medium` `done:2026-11-03T14:20:00.000Z`
```

Import also accepts ordinary Markdown checklists and bullet lists. Missing metadata gets defaults (low priority, no
due date). **Merge** matches categories by name and skips tasks that already exist. **Replace** discards all current
data first.

## Command-line options

```
2do -port 47823     # localhost port (default 47823)
2do -no-window      # only run the server; open http://127.0.0.1:47823 yourself
```

If you start 2do while it's already running, it opens another window to the running instance.

## Troubleshooting

- **It opens in a normal browser tab:** no Chromium-based browser was found on your `PATH`. Flatpak-only browsers
  aren't detected. Install one natively, or keep using the tab. In that case, press Ctrl+C in the terminal to quit.
- **"error listening on 127.0.0.1:47823":** another program is using that port. Run `2do -port 47900` (or any free
  port). Your data is unaffected because it lives in the data file, not in the browser.
- **Changes don't show after upgrading:** reload the window with Ctrl+Shift+R.

## Security notes

The local server only listens on `127.0.0.1`. It rejects requests with an unexpected `Host` header (DNS rebinding) and
writes that lack a custom header (CSRF from other websites). The data file is created with `0600` permissions.
