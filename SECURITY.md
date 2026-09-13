# Security Policy

Fair warning: I'm not a developer. I'm a bored QA guy who built a tool for his coworker and later himself and figured others might get use out of it.
This software comes with no warranty and no liability, as spelled out in the AGPL-3.0 [LICENSE](LICENSE).
Use it at your own risk, and keep your own backups of anything you care about.

That said, the app handles budget data and runs with admin rights, so I do care about getting security right. If you find something, I want to hear about it.

## Reporting a Vulnerability

**Please don't open a public issue for security bugs**. That tips off attackers before there's a fix.

Report it privately instead: go to the **Security** tab of this repo and click **Report a vulnerability**.

I'll get to it as fast as I reasonably can. No promises on timeline (one guy, spare time), but I won't ignore a real report.

## What's Worth Reporting

Anything that lets someone read or destroy data they shouldn't, run code, gain privileges, or get around the Budget Tracker's encryption. Since the app runs elevated, anything that turns user input into an unexpected file write or command is especially worth flagging.

## What's Already Known (Not Bugs)

These are deliberate choices, explained in the README's **Security & Privacy** section, no need to report them:

- Admin elevation is required (robocopy `/COPYALL` needs it).
- Most data is plaintext JSON on purpose; only Budget Tracker offers encryption (AES-256-GCM with an Argon2id-derived key). Game Stats keeps its records in a local SQLite file instead, which is also unencrypted.
- Kanban is deliberately not encrypted. A board holds task titles and notes, not the kind of data that sits behind a bank login, and encrypting it would have meant holding a key in memory for the whole session to read attachments with.
- App Lock is a UI gate, not encryption.
- Budget Tracker's snapshots are copies of whatever was on disk, so a snapshot taken while encryption was on is still ciphertext, and restoring it needs the password that was set at the time. Restoring a snapshot from before you turned encryption on puts your budget back in the clear, because that is the state that snapshot recorded.
- The asset protocol (how the app shows a file from disk inside its own window) starts with nothing allowed. The app's own data folder is added at startup, which covers Kanban's attachments and board backgrounds. Image CCR adds one file at a time, after that file has read as an image, so it can show the sources you picked and the results it wrote where you asked.
- Kanban attachments are files inside the app's own folder, named by an id rather than by anything you typed, so a card can't point at a file outside its own board. The copy keeps the original's file extension, and nothing else from its name.
- Card text you type is rendered as rich text. It is escaped before any of it becomes markup, no part of what you typed is ever put in as raw HTML, and a link is only followed when it starts with `http`, `https` or `mailto`.
- Game Stats reads a workbook you pick from anywhere on disk, and writes its exports and blank templates to your Downloads folder. Time Tracker's CSV export does the same. Every tool also has a JSON export in **Settings > Data**, which writes wherever you point it: that dialog is opened by the app's backend rather than by the page, so the file lands where you chose and nowhere else. Those exports, and the output folders you choose yourself in Image CCR, Auto-Backup and the Dummy File Generator, are the only places anything lands outside the app's own data folder.
- Game Stats' `.xlsx` reader is hand-rolled (no library) and parses a file you chose. Deliberate, since the app ships no runtime JS dependencies and the needed slice of the format is tiny, but it *is* a parser being fed outside input, so bugs in it are fair game to report.
- Budget Tracker's "re-auth on every entry" mode, and its re-locking when Windows locks, are session gates on top of the existing encryption. Not a second layer of crypto, and not a replacement for it.
- To notice a Windows lock at all, the app subclasses its own window and registers for session notifications (`WM_WTSSESSION_CHANGE`). It watches for lock/unlock and passes every other message straight through; it reads nothing about the session.
- The Kanban agent bridge is off by default and every permission inside it starts off. It lets a local AI coding agent (Claude Code, Codex, anything that speaks MCP) read and change cards on ONE board you point it at. Nothing about it crosses the internet: the agent talks to a Windows named pipe on this machine, and the app itself decides every request rather than trusting the agent to check. A refusal names the switch that would have allowed it, and every request, allowed or refused, is listed in the board's activity log.
- That pipe is scoped to your own Windows account. Its security descriptor is set by hand rather than taking the default, which would also have admitted Administrators and SYSTEM. It carries a medium integrity label on purpose, because the app runs elevated and a kernel object made by an elevated process would otherwise refuse the write from an agent running as a normal user. Requests are size-capped before anything is allocated for them, and each board's token is 128 random bits that can be revoked and reissued.
- The bridge installs a second executable, `srbk-agent.exe`, beside the app. It is the thing your agent actually runs. It holds no rules and no data of its own and, while an agent runs it, only carries messages to the pipe. The one other thing it does is the Copy Command line you paste yourself: `srbk-agent connect` runs your agent's own CLI (`claude` or `codex`, found on your PATH, not elevated) to remove any older entry for that board, save the new one in that agent's settings, and check it. It is a separate program precisely so it does not inherit the app's administrator manifest and raise a UAC prompt every time an agent starts it. Like the installer, it is unsigned, so antivirus may object to it.
- An agent granted write permissions can make a mess of a board, and that is the permission working as asked rather than a vulnerability. Kanban keeps every board as a plain JSON file with an hourly snapshot, so a board can be put back. Report anything that lets an agent reach a board it was not granted, escape the permissions it was given, or read or write outside Kanban.
- New Version Notification is opt-in and off by default. When it's on, the app makes a single read-only request to GitHub's public Releases API to check for a newer version. That's the app's only network call, and it sends no personal data (see the README's **Security & Privacy** section).
- Several tools take a path you picked: the images and folders in Image CCR, the sources and destinations in Auto-Backup, the spreadsheet Game Stats reads, the files you attach to a Kanban card. That is what those tools are for, so the path has to come from you. Nothing WRITES to a path chosen this way except the tools whose whole job is writing there.
- The installer is unsigned, so SmartScreen will likely moan about it.

Not sure if something counts? Report it privately anyway. I'd rather get a false alarm than miss something real. Plus I'm lonely and could use the conversation.
