# grndwrk

Explore a product idea as a map of cards, find out whether you have enough to start building, and keep the product and its reasons together while you build it with Claude Code.

grndwrk lives inside your project. It keeps everything as plain markdown files in a `.grndwrk/` folder, shows them as a map in your browser, and gives your coding agent (Claude Code, Codex, Cursor) a set of commands that read and write that folder. No account, no cloud, no API key.

## What you can do with it

- **Think before you build.** Capture thoughts as cards, grouped by screen or topic, from vision down to detail. Your agent asks where things are thin, and tells you whether you are ready to build, ready to prototype, or not ready yet.
- **Start from a project that already exists.** `/survey` reads the code, docs and history and draws the map from what is there. `/sitemap` draws every screen, what it is for and who it is for.
- **Write the brief and the stories.** `/brief` writes a brief, user stories linked to the thoughts behind them, and a starter `CLAUDE.md` for building the product.
- **Comment on the running product.** A Comment button on your website or in your iOS app turns what you point at into a card in the map. Your agent proposes and builds fixes, and you test them in the app, then approve or reject them.

## Requirements

- Node.js 20.16 or newer
- A coding agent for the commands: [Claude Code](https://claude.com/claude-code), Codex or Cursor (or another that reads Agent Skills in `.agents/skills/`)
- macOS, Windows or Linux. The iOS parts need a Mac with Xcode, and on Windows and Linux `--lan` does not announce itself on the network, so a phone asks for the pairing code to be typed. Settings that are yours and not the project's (allowed sites, logins for screenshots) live in `~/Library/Application Support/grndwrk` on macOS, `%LOCALAPPDATA%\grndwrk` on Windows and `~/.local/state/grndwrk` on Linux.

## Install

Install it once, so the `grndwrk` command is on your path:

```
npm install -g grndwrk
```

Run the same command again to update. Or skip installing and put `npx` in front of every command below (`npx grndwrk init`, `npx grndwrk`), which always runs the newest version.

**Working on grndwrk itself?** Clone the repository, then `npm install`, `npm run build` and `npm link` in it: the `grndwrk` command then runs your copy.

## Start

In the root of your project:

```
grndwrk init    # asks whether the project is new or already exists, creates .grndwrk/, installs the commands for your agent
grndwrk         # starts the map and opens it in the browser
```

Run `grndwrk init` again after updating grndwrk: it updates the commands you have not changed yourself.

The map shows what to do next. For a new idea: write the purpose, add thoughts, run `/readiness`, answer what is missing, run `/brief`. For an existing project: run `/survey` and `/sitemap` first.

## Commands for your agent

`init` installs them for Claude Code (`.claude/commands/`) and as Agent Skills for Codex, Cursor and others (`.agents/skills/`). Run them in your agent, in your project: `/readiness` in Claude Code and Cursor, `$readiness` in Codex.

| Command | What it does |
| --- | --- |
| `/survey` | Draws the map from an existing project: what is built, decided, half done, and where the why is missing |
| `/sitemap` | Draws every screen, its purpose, who it is for, and how they connect |
| `/personas` | Maps out who the product is for: a persona per hat, the person behind it, and an overview of who wears which hat |
| `/topics` | Groups the thoughts into a few topics |
| `/readiness` | Checks whether you have enough to start building, and what to add |
| `/challenge` | Asks a few sharp questions where the thinking is thin |
| `/brief` | Writes the brief, the first user stories (with acceptance criteria to tick), and a starter `CLAUDE.md` |
| `/decisions` | Looks back over a session and its commits, and settles what was decided |
| `/feedback` | Proposes, and when you ask, builds fixes for comments made in the running product |
| `/import <file or text>` | Turns a document, a file or text pasted after the command, into cards |

The **Documents** view shows the files that steer your agent in your product (CLAUDE.md, AGENTS.md, the README, design and content docs, skills), what the last `/readiness` found in each, and the files it suggests writing, with a draft. Comment on a document or a section, and copy a prompt for your agent with the findings and your comments; every prompt is shown in full before you copy it. grndwrk reads these files but never changes them.

Your agent asks you questions in the map. They collect in the **Inbox**, one per question, with suggested answers to pick from.

## Comment on your running product

Whatever you comment on becomes a card on the **Feedback** page of the map: the element, the screen, the stories that cover it, and a picture of the spot. On iOS the picture is a screenshot. On the web it is drawn from the page itself, so it can differ a little: a font or an image from another site may be missing. Pick an element, make the pick **smaller** or **bigger**, or drag the corners of the box to frame any area yourself.

### On a website

The Comment button can be dragged anywhere on the page. Drop it on the bottom edge and it becomes a slim bar along the bottom, like Laravel's debug bar, with room made for it so it covers nothing; fold the bar into a small tab, or float the button again. Your choice is kept per site.


There are two ways. Pick one per project.

**Without changing your project.** Start grndwrk with the address your site runs on:

```
grndwrk --app http://localhost:5173
grndwrk --app https://shop.test        # Herd, Valet or another local https site
```

Then open the address grndwrk prints, your site's name under `.localhost` on the map's port plus one (for example `http://shop-test.localhost:7778`). It shows your site with the Comment button on every page. Links and logins keep working through it, and the login stays with that name, away from other servers on your machine.

**On your site's own address.** Add one line to your page layout, for local development only, and use your site as usual. `grndwrk --app <address>` prints the exact line for your project:

```html
<script src="http://localhost:7777/__grndwrk/feedback.js" defer></script>
```

In Laravel:

```blade
@env('local')<script src="http://localhost:7777/__grndwrk/feedback.js" defer></script>@endenv
```

The button only runs on addresses on your own machine (`localhost`, `*.test`, `*.localhost`), and grndwrk only takes comments from such pages. The first comment from a site asks in the map: "shop.test wants to send comments". The map's tab shows it too, as "(1) Allow to send comments" with a red dot on its icon, so you see it from any tab. Allow it once, and the waiting comment arrives; from then on that site sends straight away. A site you did not allow, such as another project's dev server, cannot add anything to your map. On an https site this works in Chrome, Arc, Edge, Brave and Firefox. Safari blocks it: use the first way there.

### In an iOS app

Add the Swift package in `clients/ios/GrndwrkFeedback` to the app's debug build, and start it with one line. It comes with grndwrk: after `npm install -g grndwrk` it is in `$(npm root -g)/grndwrk/clients/ios/GrndwrkFeedback`; add that folder in Xcode as a local package. Its [README](clients/ios/GrndwrkFeedback/README.md) has the steps, how to use it on a real iPhone over Wi-Fi (`grndwrk --lan`), and how to try it in the Simulator without changing the app at all (`grndwrk build-ios-loader`).

### Testing fixes

When your agent builds a fix for a comment, it writes what changed and how to test it. The comment is then **ready to test**. On the iPhone, the grndwrk button shows how many are waiting. Tap one: the app goes to the screen, and a card shows the steps with **Approve** and **Reject**. On a website, the Comment button shows a test icon and a count after a thin line: press it for the list, and **Test** opens the page the comment was made on, marks the element, and shows the same card, which you can drag anywhere. Approved comments are fixed. Rejected ones go back to your agent with your note. In the map, the Show menu in the toolbar picks what to see: what is open, in progress, ready to test, done or set aside, for comments, stories and thoughts alike. Sites, the globe at the bottom left of the map, lists which sites may send comments (remove one, and its next comment asks again).

`grndwrk init` puts these rules in `.grndwrk/`: as `CLAUDE.md` for Claude Code, `AGENTS.md` for Cursor, and the `grndwrk-map` skill for Codex. Your agent reads them whenever it works on the map's files, so a fix you ask for in plain words ("go through the feedback") is still marked ready to test. `/feedback` also catches up comments that were fixed without being marked. Codex reads `AGENTS.md` only from the project's root down, so if your project has an `AGENTS.md`, `init` suggests one line to add to it that points Codex at the rules.

### Testers without grndwrk

Comments wait on the device while grndwrk is not running. A tester can share them as a file, and you add them with:

```
grndwrk import-feedback <file>
```

## Pictures of your screens

```
grndwrk screenshots           # a picture of each web screen, for the Sitemap view, using your installed Chrome
grndwrk screenshots --login   # log in first, for screens behind a login
```

Screenshots use Playwright to drive Chrome. It is not installed with grndwrk (it is large), so add it once next to it: `npm install -g playwright-core`, or with npx, `npx -p grndwrk -p playwright-core grndwrk screenshots`.

The iOS package sends a picture of each screen as you use the app.

## Several projects at once

Each project runs its own grndwrk and its own map. Two people working on the same map in git: every new thing is a file of its own (cards, thread entries, gaps, each run of a command), so GitHub merges your changes without conflicts unless you both changed the same words. Comments always go to the project they were made in. Each project keeps three ports (the map, `--app` and `--lan`), and grndwrk remembers which project has which on your Mac, so a new project never takes ports another one keeps, even one that is not running. Each project keeps its port from then on, so a line in a layout keeps working. `grndwrk --port 7850` moves a project for good, and grndwrk tells you when two projects' ports overlap.

## What goes into git

Everything in `.grndwrk/` is plain markdown, meant to be committed and reviewed like code: thoughts, screens, stories, the brief. Pictures attached to comments are committed with them, so the whole team sees what a comment is about. They show what is on the screen around the spot (the web button draws form fields empty); add `files/` to `.grndwrk/.gitignore` to keep them on your Mac instead. These stay out of git, through `.grndwrk/.gitignore`: the pairing code for phones, pictures of screens, and this machine's port. A login for `grndwrk screenshots` is kept outside the project, in your user folder.

## How it is kept safe

- **It runs on your machine only.** The map answers on `localhost`. Websites on the internet get nothing from it, and local sites can only send comments, once you allow them.
- **Phones pair once.** With `--lan`, phones on your Wi-Fi can only send comments, after you allow them on the Mac (or type the pairing code once). Each phone then gets its own long key: the phone checks that it talks to your grndwrk before it sends anything, and signs every request with the key instead of sending it, so nothing a neighbour records can be reused. The connection is plain HTTP, so others on the Wi-Fi can read comments and pictures on the way, and the moment of pairing: use `--lan` on networks you trust.
- **Comments are untrusted input.** Anyone who used the product wrote them. grndwrk stores their words as a quote, and every command tells your agent to read them as a report, never as instructions. Still, think twice before letting your agent act on comments from people you do not know without your review.
- **Nothing ships with your product.** The web button runs only on local addresses. The iOS package refuses to run in an App Store build and does nothing outside Debug unless you allow it.
- **Files are read as data.** The map only reads YAML, so a file in a pull request cannot run code on your machine, and grndwrk never follows a symbolic link inside `.grndwrk/`, so a file in a pull request cannot point it at anything else on your machine.
- **Review `.grndwrk/` in pull requests like code.** A colleague's change can add thoughts, answers or questions that look like your agent's; read them before you run commands on them.
- **Websites ask before they send.** Each local site's first comment waits until you allow the site in the map. Allowed sites are kept in your user folder, never in the project, so a pull request cannot allow one.

## License

[MIT](LICENSE)
