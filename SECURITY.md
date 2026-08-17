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
- Most data is plaintext JSON on purpose; only Budget Tracker offers encryption.
- App Lock is a UI gate, not encryption.
- The asset-protocol scope is broad so Image CCR can display images from anywhere you pick.
- New Version Notification is opt-in and off by default. When it's on, the app makes a single read-only request to GitHub's public Releases API to check for a newer version. That's the app's only network call, and it sends no personal data (see the README's **Security & Privacy** section).
- The installer is unsigned, so SmartScreen will likely moan about it.

Not sure if something counts? Report it privately anyway. I'd rather get a false alarm than miss something real. Plus I'm lonely and could use the conversation.