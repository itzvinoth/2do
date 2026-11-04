# 2do

A simple, offline-first todo app. Plain HTML/CSS/JS with no frontend framework, styled with [Oat UI](https://oat.ink).
It runs as a Linux desktop app or as an installable PWA.

- Categories: create as many as you need (Personal, Project X, …)
- Priorities (high, medium, low) and due dates
- Subtasks, nested as deep as you like
- Finished tasks move to the Archive, grouped by the day they were finished. You can reopen them
- Import and export everything as a Markdown (`.md`) file ([format](#import-file-format-md))

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
| Change due date | Click the date (or the calendar icon) to open the task dialog with the date selected. Overdue dates turn red and today's turn amber |
| Notes, or move to another category | Pencil icon |
| Delete | Trash icon |

Tasks are sorted by priority, then by due date. `` `Backticks` `` in a title are shown as inline code.

**Subtasks.** Hover over a task and click the add-subtask icon (lines with a +). Type the subtask and press Enter. The
input stays open, so you can add several in a row. Press Esc when you're done.

| Action | How |
|---|---|
| Collapse or expand subtasks | Click the `2/5` progress chip next to the parent task |
| Make a task a subtask of the one above it | Click its title to rename it, then press **Tab** |
| Move a subtask up a level | Click its title, then press **Shift+Tab** |
| Finish a subtask | Tick it. It stays under its parent, struck through, and the progress chip updates |
| Reopen a subtask | Untick it. This also reopens its parent if the parent was finished |

Subtasks always belong to their top-level task's category. Moving a task to another category moves its subtasks too.

**Finishing and reopening.** Tick the checkbox to finish a task. A top-level task moves to the **Archive** together
with its subtasks, and any open subtasks are finished with it. The snackbar offers
**Undo**. The archive groups tasks by the day you finished them (Today, Yesterday, then dates). Hover over a title to
see the exact finish, creation and due times. Use the reopen icon to bring a task back. Click **N finished** under a
category's list to see that category's archive.

**Categories.** Type a name in **New category** in the sidebar and press Enter. To rename or delete a category, open
it and use the ⋮ menu. Deleting a category also deletes its tasks.

**Import and export.** These are the two icons at the top right.

## Import file format (.md)

2do imports and exports plain Markdown, so you can write an import file by hand in any text editor. It's also the
format 2do uses when you export. To try it, import [`examples/import-sample.md`](examples/import-sample.md).

### Quick example

```md
## Personal

- [ ] Renew passport `priority:high` `due:2026-12-01`
  > Book an appointment first.
- [ ] Buy groceries
- [x] Pay electricity bill `done:2026-11-03T10:30:00.000Z`

## Project Alpha

- [ ] Write the design doc `priority:high` `due:2026-11-15`
  - [ ] Outline the API
  - [x] Collect requirements
- Review open pull requests
```

This creates two categories, **Personal** and **Project Alpha**. Project Alpha's design doc task gets two subtasks.
The finished `[x]` top-level task goes straight to the archive; the finished subtask stays under its parent.

### Rules

| Line | Meaning |
|---|---|
| `## Name` | Starts a category called *Name*. A repeated heading continues the same category, ignoring case. Tasks that appear before the first `##` heading go into a category called **Imported**. |
| `- [ ] Title` | An open task. `*` and `+` bullets work too. |
| `- [x] Title` | A finished task, which goes to the archive. `[X]` works too. |
| `- Title` | A plain bullet without a checkbox is imported as an open task. |
| `  - [ ] Title` | A subtask of the task above it with less indentation. Indent each level by two spaces (or a tab); nest as deep as you like. |
| `  > Some text` | A note for the task above it. Indent it by at least two spaces. Each `>` line is one line of the note. |
| Anything else | Ignored. This includes `#` and `###` headings, paragraphs and blank lines. |

See [`examples/tasks-1.md`](examples/tasks-1.md) for a real-world file with subtasks nested three levels deep.

### Optional metadata

To set metadata, add it at the **end** of the task line, as `` `key:value` `` in backticks, separated by spaces, in
any order:

| Key | Values | If missing or invalid |
|---|---|---|
| `priority` | `high`, `medium` or `low` | `low` |
| `due` | Date as `YYYY-MM-DD`, for example `2026-12-01` | No due date |
| `done` | When the task was finished, as an ISO date-time such as `2026-11-03T10:30:00.000Z`. Only used on `[x]` tasks, and it decides which day the task appears under in the archive. | The time of the import |
| `created` | When the task was created, as an ISO date-time | The time of the import |

### Merge or Replace

After you pick a file, 2do shows how many tasks and categories it found and asks what to do:

- **Merge** adds the tasks to your existing data. Categories with the same name (ignoring case) are combined, and a
  task is skipped if the same category already has a task with the same title, parent and done state. Subtasks of a
  skipped task are merged under the existing one. Importing the same file
  twice doesn't create duplicates.
- **Replace** deletes all your current categories and tasks, then loads the file.

If you're not sure which to choose, export first so you have a backup.

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
