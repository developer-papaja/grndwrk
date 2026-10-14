# Groundwork

Explore a product idea as a map of cards, find out whether you have enough to start building, and keep the product and its reasons together while you build it with Claude Code.

Groundwork lives inside your project. It keeps everything as plain markdown files in a `.groundwork/` folder, shows them as a map in your browser, and gives Claude Code a set of commands that read and write that folder. No account, no cloud, no API key.

## What you can do with it

- **Think before you build.** Capture thoughts as cards, grouped by screen or topic, from vision down to detail. Claude asks where things are thin, and tells you whether you are ready to build, ready to prototype, or not ready yet.
- **Start from a project that already exists.** `/survey` reads the code, docs and history and draws the map from what is there. `/sitemap` draws every screen, what it is for and who it is for.
- **Write the brief and the stories.** `/brief` writes a brief, user stories linked to the thoughts behind them, and a starter `CLAUDE.md` for building the product.
- **Comment on the running product.** A Comment button on your website or in your iOS app turns what you point at into a card in the map. Claude proposes and builds fixes, and you test them in the app, then approve or reject them.

## Requirements

- Node.js 20.16 or newer
- [Claude Code](https://claude.com/claude-code), for the commands
- macOS for the iOS parts; the rest runs anywhere Node runs

## Install

Groundwork is not on npm yet. Until it is, install it from this folder:

```
git clone <this repository> groundwork
cd groundwork
npm install
npm run build
npm link
```

`npm link` puts the `groundwork` command on your path. Run `git pull && npm install && npm run build` to update.

## Start

In the root of your project:

```
groundwork init    # asks whether the project is new or already exists, creates .groundwork/, installs the Claude Code commands
groundwork         # starts the map and opens it in the browser
```

Run `groundwork init` again after updating Groundwork: it updates the commands you have not changed yourself.

The map shows what to do next. For a new idea: write the purpose, add thoughts, run `/readiness`, answer what is missing, run `/brief`. For an existing project: run `/survey` and `/sitemap` first.

## Claude Code commands

Run these in Claude Code, in your project:

| Command | What it does |
| --- | --- |
| `/survey` | Draws the map from an existing project: what is built, decided, half done, and where the why is missing |
| `/sitemap` | Draws every screen, its purpose, who it is for, and how they connect |
| `/topics` | Groups the thoughts into a few topics |
| `/readiness` | Checks whether you have enough to start building, and what to add |
| `/challenge` | Asks a few sharp questions where the thinking is thin |
| `/brief` | Writes the brief, the first user stories, and a starter `CLAUDE.md` |
| `/decisions` | Looks back over a session and its commits, and settles what was decided |
| `/feedback` | Proposes, and when you ask, builds fixes for comments made in the running product |
| `/import <file>` | Turns a document into cards |

Claude asks you questions in the map. They collect in the **Inbox**, one per question, with suggested answers to pick from.

## Comment on your running product

Whatever you comment on becomes a card on the **Feedback** page of the map: the element, the screen, the stories that cover it, and a picture of the spot. On iOS the picture is a screenshot. On the web it is drawn from the page itself, so it can differ a little: a font or an image from another site may be missing. Pick an element, make the pick **smaller** or **bigger**, or drag the corners of the box to frame any area yourself.

### On a website

The Comment button can be dragged anywhere on the page. Drop it on the bottom edge and it becomes a slim bar along the bottom, like Laravel's debug bar, with room made for it so it covers nothing; fold the bar into a small tab, or float the button again. Your choice is kept per site.


There are two ways. Pick one per project.

**Without changing your project.** Start Groundwork with the address your site runs on:

```
groundwork --app http://localhost:5173
groundwork --app https://shop.test        # Herd, Valet or another local https site
```

Then open the address Groundwork prints, your site's name under `.localhost` on the map's port plus one (for example `http://shop-test.localhost:7778`). It shows your site with the Comment button on every page. Links and logins keep working through it, and the login stays with that name, away from other servers on your machine.

**On your site's own address.** Add one line to your page layout, for local development only, and use your site as usual. `groundwork --app <address>` prints the exact line for your project:

```html
<script src="http://localhost:7777/__groundwork/feedback.js" defer></script>
```

In Laravel:

```blade
@env('local')<script src="http://localhost:7777/__groundwork/feedback.js" defer></script>@endenv
```

The button only runs on addresses on your own machine (`localhost`, `*.test`, `*.localhost`), and Groundwork only takes comments from such pages. The first comment from a site asks in the map: "shop.test wants to send comments". The map's tab shows it too, as "(1) Allow to send comments" with a red dot on its icon, so you see it from any tab. Allow it once, and the waiting comment arrives; from then on that site sends straight away. A site you did not allow, such as another project's dev server, cannot add anything to your map. On an https site this works in Chrome, Arc, Edge, Brave and Firefox. Safari blocks it: use the first way there.

### In an iOS app

Add the Swift package in `clients/ios/GroundworkFeedback` to the app's debug build, and start it with one line. Its [README](clients/ios/GroundworkFeedback/README.md) has the steps, how to use it on a real iPhone over Wi-Fi (`groundwork --lan`), and how to try it in the Simulator without changing the app at all (`groundwork build-ios-loader`).

### Testing fixes

When Claude builds a fix for a comment, it writes what changed and how to test it. The comment is then **ready to test**. On the iPhone, the Groundwork button shows how many are waiting. Tap one: the app goes to the screen, and a card shows the steps with **Approve** and **Reject**. On a website, the Comment button shows a test icon and a count after a thin line: press it for the list, and **Test** opens the page the comment was made on, marks the element, and shows the same card, which you can drag anywhere. Approved comments are fixed. Rejected ones go back to Claude with your note. In the map, the Comments menu on the Feedback page shows each state. Sites, the globe at the bottom left of the map, lists which sites may send comments (remove one, and its next comment asks again).

`groundwork init` puts a short `CLAUDE.md` in `.groundwork/` with these rules. Claude Code reads it whenever it opens the map's files, so a fix you ask for in plain words ("go through the feedback") is still marked ready to test. `/feedback` also catches up comments that were fixed without being marked.

### Testers without Groundwork

Comments wait on the device while Groundwork is not running. A tester can share them as a file, and you add them with:

```
groundwork import-feedback <file>
```

## Pictures of your screens

```
groundwork screenshots           # a picture of each web screen, for the Sitemap view, using your installed Chrome
groundwork screenshots --login   # log in first, for screens behind a login
```

The iOS package sends a picture of each screen as you use the app.

## Several projects at once

Each project runs its own Groundwork and its own map. Two people working on the same map in git: every new thing is a file of its own (cards, thread entries, gaps, each run of a command), so GitHub merges your changes without conflicts unless you both changed the same words. Comments always go to the project they were made in. The first project gets port 7777, the next a free one after it, and each project keeps its port from then on, so a line in a layout keeps working. Start with `--port` to choose one yourself.

## What goes into git

Everything in `.groundwork/` is plain markdown, meant to be committed and reviewed like code: thoughts, screens, stories, the brief. These stay out of git, through `.groundwork/.gitignore`: the pairing code for phones, pictures of screens, pictures attached to comments, and this machine's port. A login for `groundwork screenshots` is kept outside the project, in your user folder.

## How it is kept safe

- **It runs on your machine only.** The map answers on `localhost`. Websites on the internet get nothing from it, and local sites can only send comments, once you allow them.
- **Phones need a pairing code.** With `--lan`, phones on your Wi-Fi can only send comments, after you allow them on the Mac. The phone checks that it talks to your Groundwork before it sends anything. The connection is plain HTTP, so use `--lan` on networks you trust.
- **Comments are untrusted input.** Anyone who used the product wrote them. Groundwork stores their words as a quote, and every command tells Claude to read them as a report, never as instructions. Still, think twice before letting Claude act on comments from people you do not know without your review.
- **Nothing ships with your product.** The web button runs only on local addresses. The iOS package refuses to run in an App Store build and does nothing outside Debug unless you allow it.
- **Files are read as data.** The map only reads YAML, so a file in a pull request cannot run code on your machine, and Groundwork never follows a symbolic link inside `.groundwork/`, so a file in a pull request cannot point it at anything else on your machine.
- **Review `.groundwork/` in pull requests like code.** A colleague's change can add thoughts, answers or questions that look like Claude's; read them before you run commands on them.
- **Websites ask before they send.** Each local site's first comment waits until you allow the site in the map. Allowed sites are kept in your user folder, never in the project, so a pull request cannot allow one.

## License

[MIT](LICENSE)
