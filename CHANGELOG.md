# Changelog

All notable changes to `sessionpipe-gui`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (`0.x`: anything may change between minors).

## [Unreleased]

### Changed

- **A touch screen has the touch app at any width.** A tablet turned on its side, a phone
  on its side or opened flat, and a tablet's browser got the Mac's layout from 840 px wide:
  the icon rail, "Start ⌘↵" and "… is listening." in New session, "Open in new window" in a
  row's menu, two "Approve this iPhone" under one prompt, and the page running under the
  status bar at the side. They now keep the phone's tab bar, sheets and words, inside the
  screen's safe areas, with the message field riding on the keyboard. Turning the screen no
  longer swaps the app under the hand: New session keeps its open list, the caret and the
  words being typed. The Mac's sidebar, the panel beside a list and "Open beside" are a
  window with a mouse's, which still changes at 720 px.
- **A touch screen with room has a sidebar in place of the tab bar.** On a tablet, either
  way up, and on a phone opened flat, the pages are a list down the left side of the
  screen: Board, Inbox with its count, Search, Machines, then what More held (Usage among
  them) and the views, with Display and Settings at the foot, each a row a finger takes.
  New session is at its head. The tab bar stretched five tabs across such a screen; a
  phone held upright, a folded phone, Split View and a window with a mouse keep what they
  had.
- **With room, sheets and menus float in the middle, and each page reads down one
  column.** On a tablet and on a phone opened flat, New session, Ask another agent and
  adding an account are a sheet of at most 540 pt in the middle, over a dimmed page; a
  tap beside it closes it. A row's menu, Labels and Display are a card of at most 400 pt,
  and a choice in a sheet opens as a list under its button. The Board, the Inbox, Search,
  Machines and Settings keep to a column of 672 pt. A phone held upright, a folded phone,
  Split View and a window with a mouse are unchanged.
- **On a wide touch screen a reply reads in lines of about 70 characters.** On a tablet,
  and on a phone opened flat or turned on its side, a reply's lines ran to 90 and 115
  characters, too long for the eye to find the next one. Its paragraphs, lists, quotes and
  headings now stop at about 70, from the column's leading edge, at any text size; its
  code and tables keep the column, and the bubble of what you wrote is no wider than the
  prose. A phone held upright and a window with a mouse are unchanged.
- **The iPhone app fills iPhone Duo's screens.** Built with Xcode 26, it showed in a box
  with black bars round it, folded and opened. It is now built with Xcode 27.1 and reaches
  the edges of both screens, with its controls clear of the status bar at the side.
- **The keyboard no longer covers what is being typed.** In New session, Ask another agent
  and adding an account on a phone, the field being typed in, and the line under it that
  says why Start waits, now move up above the keys; on a tablet the sheet ends above them
  wherever it was opened from. On a short screen, such as a folded phone or Split View,
  "Ask another agent…" under the message field, and Search's large title and its filters,
  fold away while the keyboard is up, so the field, Send and a few results fit above it;
  they come back when it goes. A taller phone keeps them.

### Fixed

- **The camera fills the screen when you scan a computer's code with iPhone Duo open.**
  It was the size of the outer screen, so on the opened phone it covered only part of the
  screen, upright and turned. It now fills the window either way up, and follows a turn
  and Split View.
- **A sheet dragged down no longer takes the dim from the next one.** After New session
  was put away with a drag, Display, More and the next New session opened over a page
  that was not dimmed.
- **Nothing to tap sits under what the system keeps at the side of the screen.** Where a
  phone's own bars stand in a band beside the page (a folding phone closed, in Split View
  or turned on its side) or a notch does, the page kept only the wider of its margin and
  that band: a row's time stood flush against it, a bar's last button reached under it,
  and Start in New session, the More sheet's rows, a row's menu, Labels, Display, Settings,
  a session's files and Search's pop-ups ran under it. The margin is now inside what the
  system leaves, on every page and in every sheet and menu; the bars keep their ground to
  the screen's edge. A session's title stands between its bar's buttons; the
  "Reconnecting…" pill and the pull-to-refresh ring stand in the middle of what is left,
  and a list opened from a field never opens under the band. A picture opened whole keeps
  its picture, × and arrows clear of the band too, and of the status bar and the home
  indicator in the Android app, where they ran under them. A screen with nothing at its
  sides is as it was.
- **A window dragged across 720 px wide changes its layout all at once, and keeps nothing
  of the layout it left.** Each part of the page watched the width by itself, so for a
  moment a phone's bar stood over a desktop's page; on Search that put the focus back in
  the field and threw the results to the top. Search's field now takes the focus when the
  page opens and is not given it again; a field being typed in keeps it, with its caret,
  and the results are no longer thrown to the top. In Settings, a choice opened in the
  narrow window (Mode) stayed as a page with no way back once the window was wide; the
  section shows instead. The Labels sheet becomes the dialog, and the dialog the sheet, as
  the window is resized, with the name being typed still in its field.
- **A label's name given on another device is no longer undone by "Edit labels…" open
  here.** The dialog opens with its first field in hand, and a field in hand kept the name
  it had: a name given to that colour elsewhere meanwhile did not show in it, and was put
  back to the old one as the field was left. A field now saves only a name you changed,
  and shows a new one as it arrives.
- **A label's new name that could not be saved stays in its field.** "Not saved; try
  again" showed under the old name, put back in the field, so there was nothing to try
  again. The name typed now stays, and Enter or leaving the field saves it.
- **Search's range of days fits a narrow phone.** On Android and in Chrome, the two dates
  of "Custom range…" were as wide as the browser draws a date, whatever the card's width:
  on a phone under about 400 px wide the second one stood out of the card, and at 320 px
  Apply was off the screen. The two dates now share the card's width, with Cancel and
  Apply under them. An iPhone already drew it so.
- **Copy beside a tool's input or output, and on a block of code, takes a finger.** On a
  touch screen the button answered only on its 24 points; it looks the same and now takes a
  tap 44 points across.
- **A window that changes width keeps the place being read.** A phone unfolded, folded or
  turned, or a window dragged narrower, kept its scroll offset while the page above
  wrapped anew: the reply being read, or the row on the Board, in the Inbox or in Search,
  ended up as much as a screen away. The row a third of the way down the view now stays
  where it was under the bar, and inside a reply longer than the screen the paragraph does.
  Folded back, the page is where it began. A page that changed with nothing scrolled since
  keeps its place too: a long message opened in place, a card that came in above, a list
  still moving its rows.
- **A session followed at its end is still followed after the phone is turned.** In the
  iPhone app, turning the phone upright again left the session short of its end and no
  longer following: the next reply came in below, behind a "new" pill. A scroll the
  browser made to fit the page to its new window was taken for the person's.
- **Rows no longer glide after a window changes width.** The Board's and the Inbox's rows
  slid from where the old layout had them to their new places, as they do when the list is
  sorted anew. Nothing had moved in the list: they now stand where they are.
- **An open list stays open as the phone is unfolded or folded.** A list that is a sheet on
  a narrow screen and a pop-up under its button on a wider one was drawn anew as the
  screen changed, and its filter lost the focus (and with it the keyboard). It is now the
  same list in both forms: the filter's text, the focus and the row it was on are kept.

## [0.8.7] - 2026-11-20

A round on the desktop app: on a computer a session opens beside the page, Settings opens
over the page you were on, the Board's bar has one Filter, keyboard focus is drawn in ink
so orange only means "needs you", Windows and Linux get their own menu bar and keys, and a
new version of the app brings this Mac's background service along. And pictures in
sessions: a big photo is made smaller before it uploads, a sent message shows its
pictures, an upload that fails says why, and the iPhone app on a spacesheep account can
send them to a computer once spacesheep takes them.

### Added

- **A board's link can be replaced.** `sessionpipe-gui key renew`, or *New link…* in the
  menu of a link on the Connect page (on the computer this board runs on), gives the board
  a new key, in use at once; Connect shows the new link and QR code without a reload. A
  phone or browser that came in by the old link is asked for the new one ("Open the
  board's link again"); the phone app offers to scan the code again, and the desktop app
  offers its list of receivers. Senders keep their sink token: rotating it is what stops a
  sender. The command prints no key and asks the receiver serving the state folder when
  there is one; in a folder with no board, or when the receiver on the port serves another
  folder or does not take the new key, it changes nothing and says so. A folder it cannot
  write is said in one line, not Node's error stack.

### Changed

- **The sink token is shown on the computer this board runs on, and nowhere else.** The
  Connect page opened from a phone or another computer says where the sink line is copied
  instead of showing it.
- **"This computer" is one rule everywhere.** What needs no key, shows the sink token,
  rotates it and makes a new key answers to a request from `localhost`; a receiver bound
  with `--host` to one address that is not loopback answers so to a request from that
  address instead. A browser on the computer that opens the board at its network address
  (or the `.local` secure address) uses the board's key there; with it, Setup's actions,
  the phone page's Tailscale button and search's index answer there too.
- **A pairing link carries its code alone.** It opens in a browser where the board is
  already open; a device that has never opened the board gets the page that asks for the
  board's link, and the Machines page on the computer this board runs on lists the pairing
  to approve, as before.
- `config.json` is written whole: a new file only this user can read, flushed to disk,
  then put in place, and only when it would change. A setting changes only its own field;
  fields this version does not know are kept; and the file keeps the SHA-256 of every key
  and token of 16 characters or more this board replaced, so no receiver on the folder
  takes one back. A key or token written there by hand is used from the next start,
  whatever its length, unless it is one of 16 characters or more that this board replaced
  before (a deleted `uiKey` gives a new one, as before); a running receiver takes one of
  at least 16 characters at once and leaves any other until then. `sessionpipe-gui key renew` gives a
  new key while the receiver runs.
- **On a computer a session opens beside the page.** A click or ↵ on a session opens it
  the way Settings › General › Open sessions says on every page that lists sessions: the
  Board, the Inbox, Search, the Feed, Review, ⌘K, a notification and the menu bar. ⇧ opens
  it the other way, ⌘ in a background tab. A computer that has not chosen, including one
  where an earlier version saved As a page on its own, now opens sessions beside, so the
  Board stays in view. Where the panel can't show, and on the phone, a session opens as its
  page. The two choices read Beside and As a page, in Settings and in the Board's ⋯ menu.
- **Sessions opened one after another beside the page share one tab.** A plain open beside
  the page reuses one preview tab, its title in italics; typing in it, a picture added to
  it, a double-click on the tab or a drag keeps it, and an open holding ⌘ adds a kept tab.
  Answering keeps nothing, so going down the Inbox leaves one tab.
- **On a computer, the notifications hold still under your hand.** Prompts sit nearest the
  corner, newest first, with a failed turn, Delivered and "Hidden · Undo" under them, so a
  passing card never pushes a prompt's Allow down. While the pointer or focus is on them,
  or the window is hidden, nothing leaves by itself and a new card waits; a card you
  dismiss keeps its room until the pointer leaves. On a phone a finger on a banner holds it
  the same way.
- **Allow and Deny on a notification stand only beside a request shown whole.** "Bash
  wants to run:" has the command on its own line under it; a request too long to show
  whole is two lines and "…" with one Open, which opens the session beside the page, and
  its menu has no Allow or Deny.
- **⌘⇧T and back.** ⌘⇧T goes to the newest prompt, and Tab goes down the cards as they
  are drawn. × moves focus to the next card, and from the last one back where ⌘⇧T was
  pressed; Esc goes back there too and closes nothing (it used to close the panel beside
  the page). While focus is in the notifications only the keys that work everywhere do:
  Enter, a or d no longer reach past the cards to the row under the cursor.
- **The offline line's Machines follows its sentence** ("old-mbp is offline. Machines"),
  where it sat at the far right under the notifications; × stays at the end of the line.
- **The desktop app on Windows and Linux has its own menu bar.** It had the Mac's: a first
  menu named after the app, with Services, Hide Others and Show All, and a Window menu. It
  is now File (New Session, Settings…, and Exit on Windows or Quit on Linux), Edit, View, Go
  and Help (Keyboard Shortcuts, Check for Updates…, About sessionpipe), and Alt+F opens
  File, as Alt+E, V, G and H open the rest. A Mac's menu bar is as it was.
- **On Windows and Linux the pages are Ctrl+Shift+1 to 5, and Toggle Sidebar is Ctrl+B.**
  They were Ctrl+Alt+1 to 5 and Ctrl+Alt+S, which are the colour labels' keys and, on
  Windows, the characters AltGr types. A Mac keeps ⌃⌘1 to 5 and ⌃⌘S.
- **Off a Mac the command palette's rows move with the arrows alone.** Ctrl+N and Ctrl+P
  were listed too; there they are New Session and the browser's print. A Mac keeps ⌃N and
  ⌃P.
- **The desktop app's updates are in Settings › About, under its version.** They were the
  last group of Settings › App, while About read "This copy doesn't check for updates
  itself; update it the way it was installed." The row is one sentence for each state:
  "Not checked yet" until a check has run, then "Up to date" with "Checked 40 min ago.";
  "Checking…" and "Downloading 0.8.5… 42%", with no button to press; "0.8.5 is ready",
  with a link to what's new in it and Install and relaunch; "Couldn't check for updates"
  or "Couldn't update to 0.8.5", with the reason and Try again. "Check for updates
  automatically" is the row under it.
- **A downloaded update shows in the app's menu and on the sidebar.** While one waits,
  "Check for Updates…" reads "Install 0.8.5 and Relaunch" and does that, and the sidebar's
  Settings button has a small dot and opens About. It showed only in the menu bar menu and
  at the foot of Settings › App. "Check for Updates…" opens Settings › About, where the
  check shows as it runs, with a window open or not.
- **When this Mac's background service is behind the app, Settings › About says so**, in
  a row under the app's own update with Update, and the menu bar menu offers "Update
  Background Service…". Nothing said so before, unless an option was too old for it.
- **A new version of the desktop app brings this Mac's background service along.** On
  its first launch it updates the service to its own version, from the same release, as
  Update would, and Settings › About shows the progress. It waited for that click unless a
  sessionpipe-gui of the app's version was installed. A relaunch of the same version
  still waits.
- **An option this Mac's background service is too old for says it in fewer words.**
  "This Mac's background service is 0.7.4; this option needs 0.7.5." (or "… is too old
  for this option."), with Update; another machine's is "sessionpipe on studio-mac is
  0.7.4; this option needs 0.7.5. Update it there." The command to copy, and a failure's
  line, are in a closed "Run it yourself" instead of always shown.
- **Setup's title is "Setup"**, as its sidebar entry reads. It was "Set up sessionpipe gui".
- **A dropped connection is said once, in the page's bar, with one Retry.** The only words
  were "Reconnecting · 4 s  Retry now" in the sidebar's foot, so with the sidebar hidden a
  frozen board said nothing at all, while a session said it three times, with two Retry
  now buttons. The bar now reads "Reconnecting…" or "Offline" beside the page's title,
  with Retry, in the place of the page's own line there (a session's computer and repo
  come back with the connection; in a narrow column its title gives way to the words); the
  sidebar keeps its dot, named by its tooltip, and its foot no longer grows a line. A
  session says only what follows from it: "You can answer once the connection is back." on
  an open prompt's card, or "You can send once the connection is back." under the message
  field, in place of "Sending waits for the connection", which promised a send the button
  refused. "Ask another agent…" is not offered meanwhile, and its sheet, if open, waits
  and says so. A drop that is over within 400 ms changes nothing (it turned the message
  field off for an instant), and before the first sessions have loaded the Board and the
  Inbox say it alone. The board's line for an offline computer dims with the rows it
  stands over. Nothing counts seconds any more, on the
  phone either, and a screen reader hears "Reconnecting." or "Offline." once and
  "Reconnected." once, where it read the countdown out every second. "Retry now" is
  "Retry" everywhere.
- **A Search result is three lines: its title, where it ran, and its best moment.** A row
  showed up to three moments, the earliest of its best three, so about five sessions fit
  in a window; it shows the one that matched best now (under Newest, the newest), with
  "N more matches" at its right under the time, and about eleven fit at 1440 × 900.
  Clicking the row, ⏎, Space and "Find in this session…" open at that moment, which they
  were meant to and did not. On a phone the row has one moment where it had two. A changed
  file reads "Changed src/webhooks/send.ts", as an edit reads "Edit …", where it read
  "files.changed Changed …", in the results and in a history transcript.
- **A window with a mouse keeps the desktop's layout down to 720 px wide.** A Mac window
  tiled to half a 13- or 14-inch screen (720 to 756 px) turned into the iPhone's app: a tab
  bar along the bottom, a large title, buttons a finger's size, and a row's right-click as
  a sheet from the bottom edge, with Open beside and every shortcut left out. It now keeps
  the compact sidebar with the traffic lights in it, the title in the bar, Deny and Allow at
  a pointer's size and menus at the pointer; so do the Windows and Linux apps, and a
  desktop browser's window. A touch screen under 840 px (a phone, a tablet held upright)
  keeps the phone's layout, and a view's window can no longer be made narrower than the
  main one (720 by 480).
- **In a window that narrow, a session opened beside a page covers the page.** There is no
  room for both, so it runs from the sidebar to the window's edge: its tabs, its close
  button and Esc are as before, and a wider window has it beside the page again at the
  width it had. While it covers the page the keys are the session's (none moves a cursor
  or opens a row under it), another page chosen in the sidebar leaves it behind, and the
  page's own entry there brings the page back.
- **On the Board, a and d answer the prompt under the cursor.** On a Needs you row they
  did nothing, and with a session open beside the board they answered that session,
  whichever row the cursor was on. They now answer the row under the cursor, as in the
  Inbox, and never another prompt. The row then says what became of the answer, in the
  request's place: "Allowed · waiting for studio-mac", "Not sent: …", or why it cannot go.
- **On a computer, a Board row's menu leads with Allow and Deny, and shows their keys.**
  The pair came after Open, New session here and Ask another agent…; it comes first now,
  as in the Inbox, and both show A and D beside it; the phone's sheet keeps its order. On
  a machine that is not paired a Board row's menu leaves the pair out.
- **On a computer, a plan the agent asks to start on is read in the conversation, whole.**
  It sat in the dock at the bottom, beside Keep planning and Approve plan, eight lines
  until "Show the whole plan" and then a box of its own that scrolled, while the
  conversation above it stood empty. It is now a panel right under the call that asks
  ("Asking about the plan"), at the conversation's width, and the page opens on its
  first line; the dock asks "Ready to start on this plan?" in one row, as for any other
  prompt. A plan approved while the page is open stays as it was; one answered before
  shows its first eight lines and Show all. Right-click it for Copy plan. A session that
  sends no plan (tier 2) still has the prompt's own words in the dock, and so does one
  read at a tier lens under 3. On a phone the plan stays on the prompt's card.
- **A Board row's time says how long it has been in its group.** A working row counted
  from its current tool, so a 40-minute run read "0 s" each time a tool started; it now
  counts from when it began working and holds as tools come and go. A stale row counts
  from its last word, so it reads "49 m" where it read "39 m" beside "Bash · 49 m", and
  names its tool ("Bash") with no second clock; a done row counts from when it ended or
  last spoke. A tool that has run over 3 minutes shows its age after its name, "Bash ·
  12 m". The time has one tooltip, which says what it counts: "Working since 9:31 AM",
  "No word since 9:13 AM", "Needs you since 10:02 AM".
- **A row whose last tool failed has its ✕ just before the time,** "✕ 3 s", as a
  subagent's row has it. It sat somewhere in the row's empty middle on a wide window, and
  under the time on a phone. With Show counts on it stays in the errors column.
- **The sidebar's groups are set off by hairlines, and Simple keeps to the daily places.**
  Board, Inbox and Search, then (in Advanced) Feed and Review, then Workflows and Machines,
  then the views. Simple leaves the experimental views (Canvas, Office) to Advanced, ⌘K
  and the Views page; their `g 1` … `g 9` keys stay the same in both modes. Connect is no
  longer a row, here or in the phone's More: it is Machines' Connect…, ⌘K and `g c`.
  Setup is "Finish setup", at the foot of the list while steps remain.
- **Usage is always in the sidebar.** Where its lines are not drawn (the icon-only
  sidebar, Usage in the sidebar turned off, no numbers yet, a short window) it is a Usage
  row after Machines.
- **The sidebar and the Settings list are set as a Mac's are: 13 px regular.** The fill
  marks the selected row, so its label keeps the others' weight, and the icons are 16 px.
- **On a computer, each group on Machines, Usage, Connect, Setup, Your phone, Views,
  Workflows, the pairing pages and the Welcome is a panel of its own**, as in Settings and
  on the phone: its name above, its rows in a box on the page's grey ground (dark stays
  dark), its one note under it. One machine's rows no longer run into the next one's, a
  pool's accounts and their windows are one box, and on Connect the QR and its addresses
  are one, each folded group one row that opens in its box. Rows keep their height, and
  the phone looks as it did.
- **When the first sessions never come, the Board and the Inbox name the computer they
  can't reach, and the Mac app offers to start sessionpipe.** They said "No connection to
  the receiver" or "Still connecting to the receiver…", with a sentence about the stream
  and Retry, while the sidebar said "Reconnecting" about a connection there had never
  been. They now say "Connecting to studio-mac…" while it waits, with nothing to press, and
  "Can't reach studio-mac" with Retry when it fails ("spacesheep" for an account,
  "sessionpipe" in a browser, "You're offline" with no network). For this Mac's own
  sessionpipe the desktop app reads "Can't reach sessionpipe on this Mac" and puts Start
  sessionpipe beside Retry: while it works its progress is the title, and a start that
  didn't work says so as the welcome does, with Try again. Before the first sessions, a
  page with no loading state of its own (Search, Machines) says "Connecting…" or "Can't
  reach studio-mac" in its bar, and the sidebar's dot says the same. The menu bar item
  reads "Can't reach this Mac", in lower case.
- **Settings opens over the page you are on.** ⌘, the sidebar's sliders, Display's
  "Settings…" and every other way in add `?settings=<section>` to the page's address, and
  the page stays as it was under it: its scroll, its title, its lit row in the sidebar, a
  file open in a session. It drew the Board under it before, and closing it loaded the
  page again. Done, ×, Esc and a click beside it go back to the page as it was; a link
  inside Settings, or another page, closes it on the way. On a computer the window is up
  to 720 px tall, so Data's Export shows without scrolling, and the dim under every dialog
  is lighter, so Appearance and Text size are judged on a page that is not greyed. Old
  `/settings?section=…` links open it over the page Open on names. The phone's Settings
  is the same full-screen sheet as before.
- **Focus is ink, so the orange means only "needs you".** The keyboard's ring is ink in
  every skin and both schemes, where it was the orange. A focused field's edge steps up to
  grey with a soft grey halo; the message box, which has the focus the whole time a
  session is read, only steps its edge up and never glows. The keyboard cursor's edge on a
  Board, Inbox, Feed, Search, Review or Files row is drawn at full strength, 3:1 or better
  on its fill (2 px with Increase contrast on), and a Files row no longer gets a ring of
  its own. Selected text is the system's own colour on a computer; the phone app keeps its
  tint.
- **Menus, pop-up lists and the command palette mark the keys' item with the same edge.**
  An item the arrow keys, a typed letter or a keyboard open moved to has the list rows'
  cursor edge on its fill, where it had a faint fill alone; an item under the pointer keeps
  the fill alone, as before. A touch screen is as it was. A skin whose focus ring is under
  3:1 on its page or card is listed with "low contrast", as a pale text tier is.
- **The Inbox badge counts the sessions that need you, as Needs you, the Dock and the menu
  bar do.** It counted only the prompts you could answer from here, so it said 2 beside
  "Needs you 3", and went dark once a prompt waited past its two minutes. The badge, the
  title's "(n)" and the phone's app badge now count every session in Needs you, a question
  and a prompt waiting in a terminal too (0.8.4 left both out). A session whose answer has
  gone, or that you hid, counts no more, and the Board's Needs you drops it from its
  number at once, its row in its place. The Dock and the menu bar still count a session
  you hid on this device. VoiceOver reads "Inbox, 3 need you". Notifications are as they
  were: only a prompt you can answer here raises one.
- **Settings › Data's spacesheep account is a quiet option.** Its Connect… was the one
  solid button in Settings; it is now a small one like Rebuild…, Forget… and Download
  JSON, and Disconnect is the same size. "Open the confirm page" stays solid while a
  connect waits on it. The group is "spacesheep" over "Use a spacesheep account", and its
  four-line note is one sentence, "Also shows the sessions your computers send to
  spacesheep, which keeps them.", with a Privacy policy link. On an account, Storage says
  what it holds where it showed an empty line.
- **On a computer the Board filters with one Filter button.** "All machines", "All
  harnesses", "All labels" and Clear become one Filter pop-up: Machine and Agent (each
  where there are two or more), Label ›, and Clear filters while one is on, which leaves
  the field's words. Filtered, the button says what it narrows to ("lab-mac · Codex"); with
  nothing to narrow there is no button. The field is called Filter and sits at the bar's
  right end, so it no longer moves when a filter is set, and beside a session the bar
  stays one row. The Inbox's label filter and the Feed's are the same button, the Feed's
  with Label › in it; the Inbox's lens now comes before the bell, and Tab follows the bar
  from left to right. A phone keeps its chips, under the field now called Filter, and its
  agent chip reads "All agents".
- **A filtered Board ends with "Search every session for “webhook”",** which opens Search
  with the words, and ⇧⌘F in the field does the same. When nothing matches, the title says
  so with no paragraph under it, then "Search every session for …" and Clear filter. The
  palette says the same words, and `/` is "Find on this page" in Shortcuts.
- **"Agent" where the app said "harness":** the Feed's filter, Setup's list and Search's
  `agent:` hint.

### Fixed

- **A right-click just after a menu closed opens its row's menu.** For 0.4 s after any menu
  opened, a right-click did nothing: right-clicking a Board row moments after Allow, Hide or
  Esc on another row's menu, or after `.`, showed no menu and had to be done again. Only
  the browser's own second event for a menu still open is ignored now.
- **`--port` and `--keep-days` take digits only, and a flag is never another flag's
  value.** `--port ""` (a script's unset `$PORT`) started on a random port and
  `--keep-days ""` kept every event whole, both without a word; `--port 0x1F90` listened on
  8080. `--host --no-tls` took `--no-tls` as the host. Each now stops with the flag's own
  message.
- **"Switched to …" stays under the turn it fell in.** On a long session whose switch to
  another account is older than its newest page, the chat and the timeline drew the note
  under the first turn the page had loaded; it now appears, under its own turn, once Older
  turns brings that turn in.
- **Closing the terminal stops the receiver cleanly.** Closing the window or tab a
  receiver runs in (SIGHUP) ended it at once and left its `run.json` behind; it now stops
  as Ctrl-C does. A receiver whose output was already gone when it was stopped (a `| tee`
  ended by the same Ctrl-C) no longer exits with an error before it has closed.
- **Search's status line says which computer to restart.** With history search off and its
  index still on disk, a viewer on another device read "Restarting the app tries again",
  which could mean the app on the phone; it now reads "Restarting the app on that computer
  tries again".
- **`--rp-id` takes a host name alone.** `--rp-id https://foo.example`,
  `--rp-id foo.example:7373`, a path or an empty value started a receiver whose passkey
  origin (`https://https://foo.example:<port>`, `https://:<port>`) no browser makes a
  passkey for, without a word. Each now stops with an `--rp-id` message; an IP address is
  taken as before.
- **`tls status` names a broken certificate file.** A certificate folder with a file
  missing, cut short or not a certificate was reported as "none yet", and an unreadable
  `server.key` ended in Node's stack trace. It now names the file and the cause, and says
  what the next `--tls` start does about it: a new server certificate from the same CA, a
  new CA that phones must trust again, or nothing, when the file has to be fixed by hand
  (or the folder deleted with `sessionpipe-gui tls reset`). A `tls` folder this account
  cannot read is named too, instead of "none yet".
- **Search's `since:` and `until:` refuse a day the month does not have.** `until:2026-02-30`
  searched up to March 2, `since:2026-11-31` from December 1 and `2026-02-29` read as March
  1, without a word, and the Date chip said "Until Mar 2". Such a date is now left out, as
  `2026-13-01` already was, and the receiver's Search page and `sessionpipe-gui search`
  name it ("“until:2026-02-30” isn't a date, so it was left out"). `2028-02-29` still reads.
- **A picture is made smaller before it uploads.** In the message box and in New session,
  a big photo or screenshot is redrawn at most 2560 px on its long edge, as WebP (JPEG
  where the browser can't write WebP), the way spacesheep does it: a 13 MB phone photo
  goes at about 2 MB, and a 30 MB screenshot goes at all. A picture may be 50 MB before
  and 25 MB after (8 MB where the prompt names its path). A HEIC photo is sent as a JPEG
  where the browser can open one (Safari, the apps on a Mac and an iPhone); elsewhere the
  message box says how to export it, and New session sends it as a file with a note that
  the agent can't look at it. A JPEG that says where it was taken is always redrawn, which
  leaves the location behind; one that can't be redrawn goes without its metadata. The
  thumbnail's tooltip says the size it goes at and the size it was.
- **A sent message shows the pictures it carried.** In the session's view, and in the row
  of a message that went to a copy of the session, each picture is a thumbnail that opens
  it whole: while the message is on its way, once the session's turn arrives and after a
  reload, for a message and for a new session's first one alike. The list of saved files
  the computer adds to the message is no longer shown as text. Any other file, and a
  picture the receiver no longer keeps, is a chip with its name, type and size
  (`kiwi.png · PNG · 32 KB`). The receiver keeps a picture you sent for 30 days to show it,
  and makes room among those, oldest first, before it refuses an upload for space.
- **In the desktop and phone apps, a picture on a slow connection has time to arrive.** A
  request to a receiver was cut off after 15 seconds, so a large photo on a slow uplink
  failed with `http_504`; it now has 15 seconds and one more for each 32 KiB it carries (up
  to ten minutes), and an answer that keeps coming, such as a large picture on a slow
  downlink, is read for as long as it does. An answer that stops for 15 seconds is still
  cut off.
- **New session on a computer reached through spacesheep offers only folders spacesheep
  takes.** It used to offer a recent session's `~/…` folder, which spacesheep refused
  ("only lets the agent work in"); now it offers the computer's own folders and recent
  ones under them, as full paths, and Start sends the full path. New session here and Ask
  another agent, from a session in a `~/…` folder, start from those too.
- **Pictures another surface sent are chips, not links or paths.** A message sent from
  spacesheep's Talk pane shows each picture by its name (`kiwi.png · picture · kept on
  spacesheep`) instead of its link, on the board, on a spacesheep account and in a row of
  the board, which quotes only the words. On a spacesheep account, a message sent from an
  older version of this app's message box shows a chip for each picture it named
  (`picture · 1200×900 · kept on the board it was sent from`), and one of pictures alone is
  its chips instead of an empty bubble.
- **A picture that doesn't upload says why, and keeps its place.** The message box and
  New session say what went wrong in one sentence, offer ↻ where trying again can help,
  and show how far an upload is. A picture dropped anywhere on a session's page goes to its
  message box, and an unsent message's pictures come back with its words after a reload.
- **A picture is shown whole, and opens over the page.** A thumbnail in the message box
  and in a sent message is the whole picture, in a frame of its own shape up to 120×88,
  so two screenshots that start alike can be told apart. A sent one opens large over the
  page in the browser and in the desktop and phone apps alike: Esc, a tap outside it or ×
  closes it, and the arrow keys (or the two arrows beside it) go through the message's
  pictures. A picture that doesn't load is a chip with its name, never words in an empty
  frame, and why one in the message box can't go is said once, on a line under them all.
- **An agent's reply keeps its lines.** A single line break in a reply is a line break
  on the page, the way the agent wrote it, everywhere a reply is shown.
- **A phone's browser on the board's Wi-Fi or tailnet address says what works there.**
  Over plain http no passkey can sign, so the line under the message box says: "To send
  from this phone, use the sessionpipe app (scan the code on /connect) or open this board
  over HTTPS (start it with --tls).", with /connect a link, and the greyed paperclip says
  the same.
- **On a spacesheep account a new session's level is not second-guessed.** spacesheep
  doesn't say what level the computer ran a start at, so the session no longer says the
  computer ran it at its own mode.
- **The iPhone app asks for the camera for photos too.** Its question now says it reads
  your computer's code and takes photos you send to a session.
- **Pictures reach a computer through spacesheep.** The iPhone app on a spacesheep
  account, and a board connected to spacesheep, now have the paperclip, paste, drop and
  the camera for a session on a computer whose sessionpipe is 0.10 or later, and New
  session takes pictures and files for one: they upload to spacesheep, where the computer
  fetches them. A sent message shows them as thumbnails on the device that sent them
  (kept 30 days, up to 50 MB, and removed with the account on Disconnect) and as chips
  elsewhere. A computer with an older sessionpipe gets the line to update it, and a
  spacesheep that takes no pictures from here says so once (`spacesheep.dev can't take
  pictures from here yet.`) and the paperclip is gone until the app or the page is opened
  again.
- **A session's title is plain words everywhere.** A title written with Markdown showed
  its marks: "the old \`--sink\` flag?". It now reads "the old --sink flag?" wherever a
  title shows, in the menu bar and notifications as well. Code written without backticks
  (`__init__.py`) stays as it is, in previews too, and a preview no longer drops a " - "
  after a code span.
- **↵ on a list does what the row's menu says.** With Open sessions set to Beside, the
  menu read "Open beside ↵", but ↵ opened the page. Now ↵ and ⌘1 to 9 open the way
  Settings says and ⇧↵ the other way, on the Board, the Inbox and the Feed, and so do a
  click and ⇧-click on the Board and the Feed; ⌘ opens a background tab.
- **A colour label sits after the title, so the titles line up.** Its dot sat
  between the state and the title, which moved a labelled row's title and preview about
  5 px right of its neighbours'. It now follows the title, 6 px after it (after the …
  when the title is cut), on the Board, a child session's row and the Inbox, as Search
  already had it. The lead holds the state alone, and ⌘'s jump number lands on it.
- **"Menu bar only" can no longer hide the Mac app completely.** With "Show in menu bar"
  off and "Menu bar only" on, the app ran with no Dock icon, no menu bar item and no app
  menu. "Menu bar only" now sits under "Show in menu bar" and shows only while that is
  on; turning the menu bar item off turns it off too and brings the Dock icon back, and an
  app saved in that state opens with its Dock icon. While there is no Dock icon,
  "Show count on the Dock icon" is not shown, where it was greyed without a reason. On
  Windows and Linux "Menu bar only" is gone: all it did there was switch off the taskbar
  count.
- **The desktop app's "Start sessionpipe" says what went wrong, in one sentence.** On a
  computer without Node the welcome read "It didn't start: sessionpipe needs Node 20 or
  later" and gave no next step. It now reads "Install Node 20 or later from nodejs.org,
  then try again.", with the site as a link that opens in the browser, and Try again. A
  start that failed reads "It didn't start."; the installer's own line is under Details,
  with Copy. A receiver that started and is still loading its board reads "Give it a
  minute to load, then try again." instead of being called not started, and while another
  install or update is already running the button waits for it rather than being refused.
  The button keeps the focus while it works, so Return tries again.
- **The welcome and the phone's install steps no longer show `npx -y sessionpipe-gui
  service install`.** The GUI is not on npm under that name, so the command could only
  fail, or run whatever someone published there. Try again does what it was for; on the
  phone, step 1 is "Download it from sessionpipe.org/gui."
- **⌘K offers Allow and Deny only where the answer would be sent.** The palette listed
  them for every open prompt: on a machine that is not paired, on one that does not trust
  this Mac yet, for a Claude Code prompt past its two minutes, and for one already answered
  from a toast or the Inbox. Enter then signed an answer that was refused, or only said it
  was not sent. Such a prompt has no Allow or Deny row now; its session keeps its row under
  Sessions, and its page says why and what to do. "Send a message…" is listed the same
  way, only for a session a message can go to. The cursor stays with its row: when a
  prompt leaves the list while the palette is open, the cursor goes to that session's row
  and never onto the row that took its place, so an Enter already on its way cannot answer
  another prompt.
- **The system's Increase contrast setting takes effect.** With it on (macOS:
  Accessibility › Display; iOS: Accessibility › Display & Text Size), meta text, marks,
  dividers and the edges of fields and buttons step up, in every skin and both schemes, as
  soon as it is switched. Before, only the focus ring got thicker: a skin's own colours
  outranked the rest.
- **A switch reads on or off at a glance, in both schemes.** In dark mode a switch that was
  on was a pale grey track under a white knob, which reads as greyed out on a Mac; it is
  now a mid grey the knob stands out on. A switch that was off was a faint pill, in dark
  mode a white dot with no track: on a computer it now has a thin grey edge, so the knob
  is seen to sit left. The Text size slider's knob gets the same edge. The phone's
  switches are as they were.
- **A new board names the agent this machine has hooked, and the command that starts
  it.** With only Codex hooked it read "Start Codex in any terminal…" over `$ claude`. The
  line now reads "Start a new Codex session in any terminal on studio-mac." over `$ codex`
  (`$ gemini` for Gemini; an agent that is an app, such as Antigravity, gets no command),
  and says "new" because an agent already running doesn't show up. "Listening" names only
  the agents whose hooks are on. "Try the demo" (it was "See it with sample sessions") and
  "Pair another machine" are two quiet buttons under it. Until a session arrives, the
  board's ⋯ and right-click menu offer only Open sessions and Mode: Find…, Show done
  sessions, Mark all as read and the rest had nothing to act on.
- **The demo says it is a demo once.** The board repeated the yellow bar in a second band
  with its own way out, "Leave samples"; the bar and its "Leave the demo" are the only
  ones now, and Needs you sits right under the page's bar. The sidebar has no Setup entry
  in the demo: it led to the real machine's setup from a board of made-up sessions.
- **Ctrl+Alt+1 to 5 set a colour label in the desktop app on Windows and Linux.** The menu
  took them for the pages, so Red to Blue could not be set from the keyboard, though the
  Shortcuts page and a row's Label menu listed them. On Windows AltGr also types again
  where the menu had its keys: ² and @ on the 2, ś on the S.
- **⌘K opens the command palette in the iPhone and Android app with a keyboard.** The page
  left it, with ⌘F and ⌘[, to a menu bar a phone doesn't have.
- **⌘1 to ⌘9 open a list's n-th item on a keyboard whose digits need Shift.** On an AZERTY
  keyboard the key types "&", which was read as another key. A shortcut recorded with ⌘ or
  Ctrl, Shift and a digit is now written with the digit (Ctrl+Shift+1, not Ctrl+!).
- **The Mac app has one "Notify me" switch, in Settings › Notifications, and the Inbox's
  bell follows it.** Settings › Notifications showed the browser's switch, which spoke of
  "this tab" and could not be turned on in the app, while the one that works sat under App,
  below the shortcut. Notifications now opens with "Notify me when a session needs me",
  then Pause and what to notify about, then the sounds; App no longer has the group. A
  pause is one row, "Paused until Thu 8:00 AM", with Resume, and the list's "Off" reads
  "Not paused". When macOS refuses, the panel is one row, "Notifications are off for
  sessionpipe", with Open System Settings, and no switch that can't be turned on. The
  Inbox's bell was struck through with notifications on: the bell, its popover and the
  Inbox's menu now read the same switch (in the phone app too), and the Inbox says
  "Notifications are off for sessionpipe" only while the switch is on and macOS refuses.
  On Windows and Linux, where the app posts no notifications, the switch that could only
  be refused is gone from Settings › App and from the first-run sheet. In the phone app,
  Settings › App keeps the switch without the kinds and Pause, which the phone never read.
- **In the Mac app a prompt is heard once.** With the window behind another app, a
  permission request or a question played the notification's sound and the banner's chime.
  The banner in the window is silent now whenever macOS sounds its own; with the window in
  front, while paused, and for an error or a finished session, whose notifications make no
  sound, it plays as before.
- **The sounds are named as the notifications are.** "Needs you", "Question", "Error" and
  "Done" are "Permission requests", "Questions", "Errors" and "Delivered"; the sound
  chosen for each is kept.
- **Ask another agent dims the whole window, as New session does.** The sheet's backdrop
  covered only a band in the middle of the window, so the sidebar, Back, Files and ⋯ stayed
  bright around it and took clicks: one on the sidebar opened another page under the open
  sheet. The whole window dims now, and a click anywhere outside the sheet closes it and
  goes nowhere; what was typed is kept for that session. On a phone the sheet covers the
  tab bar, which was drawn over its foot, and on an iPad held upright it fills the width,
  where the page showed beside it. A right-click on the sheet, or a finger held on it on a
  phone, opened the message bar's menu over it; it opens none now.
- **Every way into Search puts the caret in its field, and Tab goes from the field to the
  results.** Opened with g /, with / or Edit › Find on Review, from the command palette or
  from the Board's "Search every session for…", Search left its field without the focus,
  so the letters typed next were shortcuts: c opened New session, t switched dark and
  light, l changed the lens. Only the sidebar's link and ⇧⌘F reached the field; they all do
  now. From the field, Tab moves to the result under the cursor, where Space peeks, "."
  opens its menu and ⌘C copies its resume line; no key from the field reached a row
  before. The results are one Tab stop, the cursor's row. A filter's name still completes
  with Tab first, and with no results Tab goes on to the next control. On a row, Esc goes
  back to the field with its text selected, as "/" does (Esc did nothing there), and j
  pressed from Sort lands on the top result, not the second.
- **A session opened as a page keeps the other tabs beside it.** With sessions open as
  tabs beside the Board, a click on a card, a search result, a notification or "Open as
  page" closed every one of them: Back brought them back, the sidebar's Board did not, and
  the next launch did. The panel now stays until you close it. The tabs go along beside the
  session's page and are still there on the Board; "Open as page" moves that one tab out,
  its neighbour taking over, in one step that Back undoes; and the next launch puts back
  the tabs last on screen. A notification that opens the app on a session no longer shows
  that session a second time, in a tab beside its own page. A session's link, and "Copy
  link", still name the session alone. A phone, where a session's page is the whole
  screen, is unchanged.
- **"Open on" is where the app opens, also when tabs were left open beside a page.** With
  a tab left in the panel, the next launch stayed on the Board whatever Settings › General
  said: the tabs it put back counted as an address someone had asked for. It now lands on
  the chosen page, with the tabs beside it. In the desktop app, Go › Board with the window
  closed opens the Board, not the page "Open on" names.
- **About says the app's own version.** In the desktop and phone apps it showed the
  receiver's, which can be an older background service or another computer's. That one is
  a line under it now, only when it differs: "This Mac's background service runs 0.8.3.",
  or "studio-mac runs 0.8.3." The line under the name is "Every coding agent you run, on
  one board." and the foot is "Apache-2.0", everywhere: "no account" and "nothing here
  calls anywhere but its own origin" were not true of an app that checks for its updates
  and can use a spacesheep account. In a browser and the phone app the Updates row is
  gone; it could only say that the copy doesn't update itself.
- **The desktop app no longer says "up to date" before it has checked.** For the first
  seconds of a launch, and with the automatic check off, the row read "sessionpipe 0.8.4
  is up to date". An install or a download that failed was titled "Couldn't check for
  updates"; it now names the version, and the caption is the reason alone.
- **"Check for Updates…" no longer opens General.** With the window open it showed the
  first section of Settings while the check ran in another; with none it said nothing
  until the download had ended, then asked in a dialog that pointed at a menu bar item
  that may be switched off.
- **The side panel draws a session's needs-you dot whole.** With a session open beside the
  Board or the Inbox, the chat's tools line ("Asking to run Bash", "Ran 4 tools") hung its
  dot, spinner or chevron into a gutter the panel doesn't have, and the panel's edge cut
  the orange dot in half. In the panel the glyph now sits on the reply's edge, as it does
  on a phone, and the first message starts 8 px under the tabs instead of touching them. A
  session's own page is as it was.
- **No box around a file's versions.** In the Files drawer, "‹ 2 of 5 ›" over an opened
  file sat in the browser's own grooved rectangle, which read as a focus ring that never
  left. It is gone, and the bar is only as tall as the Changes | Text switch beside it.
- **A segmented control's labels stay inside their segments.** "Best match" ran out of its
  pill on Search, and "Advanced" touched its edge in Settings › General. Every segment is
  now as wide as the widest label, with the same room on both sides of it. A control that
  spans its row (System | Light | Dark in Quick settings, the two ways on the phone page),
  the Files drawer's switches on a phone and a view's own bar (Canvas's presets) are as
  they were.
- **⌘K's preview shows what a session is waiting on.** With nothing typed the cursor
  starts on a session that needs you, and the preview beside the list showed what you had
  asked it ("Asked"), not the command it wants to run. It now shows the request as the
  Board's row does: the tool ("Bash", "Question", "Plan") and under it the command, the
  path or the question, up to five lines. "Asked" is left out while a session needs you,
  and an Allow or Deny row previews the prompt it answers.
- **⌘K's bold letters are in the words a row shows.** Typing "webhook" left most sessions
  with the word in their title with nothing bold: the match was marked on the branch,
  which a row does not show. The word is bold in the title wherever the title holds it,
  and a session found only by its branch or its model shows that after the repo
  ("lab-mac · acme/billing · demo/webhook-backoff") with the match bold; a long branch
  shows the end that matched ("…retry-backoff").
- **In the Mac app the head of a session open beside a page drags the window,** as the
  page's bar does.
- **The Files drawer no longer lies over the sidebar in a window with a mouse under
  1000 px wide,** nor over the Mac app's traffic lights: it starts where the sidebar ends.
- **A session's menu shows no key that does something else, and no item that would only
  be refused.** "New session here" showed C, which opens New session for the board's
  machine, never for that session's machine and folder; "Ask another agent…" showed ⇧A on
  rows and tabs, where the key does nothing or asks about another session. "New session
  here" has no key beside it now, and "Ask another agent…" shows ⇧A only in a session's
  own "⋯". On a machine that is not paired, or whose sessionpipe cannot ask, "Ask another
  agent…" was greyed with its reason in a tooltip only; it is left out, as the button
  under the composer is.
- **The right-click that opens a menu no longer chooses from it.** Letting the button go
  ran the item under the pointer, and the first one starts a few pixels from where the
  menu opens. Only a press held and dragged onto an item chooses it now.
- **The receiver rejects an event time on a day the month does not have, or at hour 24.**
  An event dated `2026-02-30`, `2026-11-31` or `T24:00:00Z` was accepted and filed under
  March 2, December 1 or the next day, though `schemas/v1/event.json` refuses it. It is now
  rejected as `bad_time`, as `T25:00:00Z` already was, and the outbox and spacesheep sources
  skip it as they skip any other invalid event; `2028-02-29` is still accepted.
- **`tls status` agrees with the next `--tls` start in three more corners.** With the CA
  near its end beside a file that needs a hand, status said to fix it by hand while the
  start makes a new CA; with `server.key` or `server.crt` read-only and the server
  certificate due to be remade, or a folder in place of `ca.crt` (or any of the four
  files), it promised a new certificate that the start then fails to write or delete. It
  now says a new CA in the first case and names the file to fix by hand in the others. The `tls status` line in
  `--help` says what it prints for a broken set.

## [0.8.6] - 2026-11-19

The web app is built on React 19 and Vite 8, and the receiver runs sessionpipe-core 0.17.0;
with them sessionpipe-gui needs Node 22.12 or later, or Node 20 from 20.19 on. And a round
of fixes, most of them from contributors: files a Windows editor saved with a byte-order
mark load, a `--host` or `--port` the receiver cannot listen on is named, an event the
store could not write is read from the outbox again, and Search says which filter value it
could not read.

### Changed

- **sessionpipe 0.17.0.** The receiver runs sessionpipe-core 0.17.0 (it was 0.13.6), and its
  conformance fixtures are that version's (170 control vectors, 33 delivery scenarios). A
  session of Grok Build, whose hooks sessionpipe reads from 0.16, is named "Grok Build" on
  the board and in search's agent chips, where it read `grok-build`; fx, which a 0.16
  machine can start and message, is listed under its own name. Events and commands are
  accepted and refused as before.
- **A view gets React 19.** `api.react` is the host's React, now 19. What React 19 took
  out is gone from it: `ReactDOM.render`, `hydrate`, `unmountComponentAtNode` and
  `findDOMNode`, string refs and legacy context; `propTypes` and a function component's
  `defaultProps` are ignored, and an element made by another copy of React is not drawn.
  A view that bundles its own React, and the bundled Canvas and Office, draw as before.
  [docs/theme-authoring.md](docs/theme-authoring.md) lists what to use instead.
- **sessionpipe-gui needs Node 22.12 or later, or Node 20 from 20.19 on** (it was any Node
  20): what the web app's build (Vite 8) needs, and `npx github:spacesheep-dev/sessionpipe-gui`
  builds it on your Node. An older Node is told so in one line, before anything is installed.
  Working on the code needs 22.12 or later.

### Fixed

- **A shortcut's keys are read out as they are shown.** On the Shortcuts page a screen
  reader said "Command palette: mod+k. Press to change" where the key shows ⌘K (Ctrl+K on
  Windows and Linux); it now says the key as it is drawn, ⌘K or Ctrl+K, and so for every
  key with a modifier. The text of a two-key shortcut such as g b is "g b", two keys, not
  the one word "gb", there, in the `?` help and in Settings › Keyboard. Nothing on screen
  moves.
- **Turn on (the secure address) finds openssl on Windows.** The receiver looked for
  `openssl` on the PATH only, and neither Git for Windows (its `usr\bin`; only `Git\cmd` is
  on the PATH) nor `winget install ShiningLight.OpenSSL.Light` (`Program Files\OpenSSL-Win64`,
  `-ARM` on arm64) puts it there, so Setup kept saying "Needs the openssl command" with
  either installed. It now also looks in those folders, so an install shows without a PATH
  change or a restart, and the note says so.
- **A saved workflow run whose plan does not read no longer stops the server.** A run in
  `workflow-runs.json` with a plan step that is not an object, has no entry in `steps`, or
  has an `after` that is not a list of step ids threw from the orchestrator's tick, and the
  server exited about a second after every start. Such a run, and one whose plan step has
  text that is not a string, an id that is not an id or is used twice, or an `after` naming
  a step that is not before it, is now left out when the file is read, as a workflow that
  no longer reads already is; so is a run whose input or a step's reply is not text, and
  one with an entry in `steps` that no plan step names (it kept the run from ever ending).
  The other runs are kept, and the file as it was is set aside as
  `workflow-runs.json.bad-<time>`; until it can be, the runs left out are written back with
  the others. A run started from now on with a step called `__proto__` keeps that step's
  entry in its `steps`, so it is read back like any other.
- **A picture sent from Windows to an older sessionpipe shows in the message, and is
  kept.** For a session on the same computer whose sessionpipe is older than 0.10, a GUI
  on Windows names a picture by its path, with `\`. The message did not read that back, so
  the picture was missing from it, and the daily clean-up did not see it in the stored
  events, so a picture a session still named was removed once it was 30 days old. Both now
  read either slash.
- A session's "missing events" flag waits 30 s from when each hole opened. When an older
  hole filled while a newer one was still open, the newer one kept the older one's time,
  so it was flagged at once, with a "since" from before it opened.
- **An event the store can't write is read from the outbox again, not lost.** When the
  store failed to take a batch from this machine's outbox (a full disk, a store file the
  GUI may not write), the reader had already moved past it, so those events never reached
  the board, even once there was room again; the same failure during the first read at
  start left the outbox off until a restart. The batch is now read again on the next tick,
  said once, and the other sessions carry on meanwhile.
- **A color theme, skin, view or plugin saved by Notepad or PowerShell 5 loads.** Those
  editors start a UTF-8 file with a byte-order mark, and the receiver refused it: a theme
  in `color-themes/` was listed as "not JSON: Unexpected token", and a `skin.json`,
  `theme.json` or `plugin.json` as "not valid JSON". It now reads past the mark, as it
  already did for `config.json`.
- **A `control/machines.json` that does not read no longer unpairs every machine.** One
  saved with a UTF-8 byte-order mark (PowerShell 5's `-Encoding UTF8`, older Windows
  editors) is now read past it. One left empty, cut short, unreadable or without a list of
  machines was read as "no machines": the receiver deleted every machine's queued sends at
  start, and the next pairing or hello wrote the file over, so every machine had to pair
  again. The receiver now stops at start with a message naming the file and what to do, as
  it does for `config.json`, and leaves the file as it was.
- **Search's status line says when history search is off but its index could not be
  deleted.** It read "The index needs rebuilding" instead. It now says the history index
  could not be deleted, and that Rebuild (on this computer) or restarting the app tries
  again; `sessionpipe-gui index --status` against a running GUI says so too, with the error
  code when there is one, and points at `index --rebuild`. The status carries a new
  `historyLeft` field for it.
- **Search names a filter value it could not read.** `since:2026-2-1`, `until:3days`,
  `in:everything` or `source:mars` was left out of the search but reported as "“since:”
  isn't a filter, so it was searched as text", though `since:` is a filter and nothing was
  searched as text. The page and `sessionpipe-gui search` now say "“since:2026-2-1” isn't a
  date, so it was left out", with the forms that read (an unknown `in:` or `source:` value
  lists the fields or indexes), and keep the old words for a key that is not a filter.
- **Search finds Gemini CLI history when `GEMINI_CLI_HOME` is set.** Gemini CLI keeps
  its `.gemini` folder inside that path, but search took `$GEMINI_CLI_HOME` to be the
  `.gemini` folder itself, so it found none of those sessions. It now reads
  `$GEMINI_CLI_HOME/.gemini`; with the variable unset nothing changes (`~/.gemini`).
- **Labels, read marks and usage limits saved with a byte-order mark are kept.** A
  `labels.json`, `marks.json` or `limits.json` saved by Notepad or PowerShell 5 (which
  start a UTF-8 file with a byte-order mark) was taken for a broken file: it was set aside
  as `<file>.bad-<time>` and the board started without its label names and colours, read
  marks and notification levels. It is now read past the mark, as `config.json` is.
- **A GUI that stops at "port N is in use" ends there.** The search indexer it had already
  started then printed a Node crash (`Error: write EPIPE`) on the same terminal. It now
  stops quietly once the GUI has gone, as it does when a GUI is stopped while indexing.
- **A `--host` or `--port` the receiver cannot listen on is named.** A `--host` that is
  not an address of this machine (say, after a network change) or a name that does not
  look up, and a `--port` this user may not open, stopped with Node's own message
  (`listen EADDRNOTAVAIL: …`, `getaddrinfo ENOTFOUND …`, `listen EACCES: …`). It now says
  which flag to change, as it already did for a port in use, and still exits 2.

## [0.8.5] - 2026-11-18

Pictures from a session's message box reach the agent as files in the session's own
folder, at every permission level, and the receiver is stricter about which requests it
answers: a browser on its own pages, a proxy's visitor by the proxy's own word, and a
pairing link that carries the board's key only for a pairing the sink token started.

### Changed

- **A picture sent from a session's message box reaches the agent as a file in the
  session's own folder.** Until now the message named it: by a path in the GUI's own
  folder, which a session at Safe could not read and one at Accept edits asked about, or,
  for a session on another computer, by a link to this board, which often could not be
  opened from there. A computer whose sessionpipe is 0.10 or later
  now fetches each picture itself and saves it under `.sessionpipe/files` in the session's
  folder, where the agent reads it at every permission level. The message holds your words
  and nothing else. A picture may be 25 MB (it was 8), six to a
  message and 50 MB together; two upload at a time and the rest wait; a pasted screenshot
  goes under a plain name (`image.png`, `image-2.png`); and a picture with no words is sent
  as "Look at the attached picture." A file that is not the picture its type says is
  refused in words, and so is one that did not arrive whole. An older sessionpipe on the
  computer the GUI runs on still gets the path.
- **Where a picture cannot be sent, the message box says so.** For a computer whose
  sessionpipe is older than 0.10 and that is not the one the GUI runs on, and for one
  reached through spacesheep, there is no paperclip, and a picture pasted or dropped is
  answered under the field ("Pictures can't be sent to studio-mac: its sessionpipe is older
  than 0.10. Run `sessionpipe update` there.") where it used to vanish or go as a link.
  A file dropped on the message box that is no picture stays out of the way: the browser
  no longer opens it in the page's place.
- **A view's `control.attach` answers the board's own path to the image.** `url` is
  `/attachments/<id>.<ext>`, with no address: it shows the image on this board
  and opens nothing from another computer. A view that sends an image names its `path`.
- **A pairing link carries the board's key only when the sink token started the pairing.**
  A pairing started with no token (`sessionpipe connect`, or `sessionpipe control pair` on
  a machine that has no sink for this GUI) gets a link with its code alone: open it in a
  browser where the board is already open, or approve it on the Machines page, which lists
  every pairing that waits. A pairing the sink token started (Setup's "Pair this machine",
  a machine that has a sink for this GUI, `--token`) gets the link it always did.
- **Through the proxy of `--public-url`, every request is a visitor's.** The visitor's
  address is the last one in `X-Forwarded-For`, the one the proxy itself wrote; what
  stands before it is not read. A request that came through the proxy needs the UI key
  and is not this machine, whatever address the proxy names for it, and whether the proxy
  reaches the port on `localhost` or on one of the machine's own addresses. A request
  marked with `Forwarded`, `X-Real-IP`, `X-Forwarded-Host` or `-Proto` and no
  `X-Forwarded-For` counts as one too. On the machine that runs the GUI, Setup's actions
  and the search index's are done at `http://localhost:7373`, not at the proxy's address,
  and a browser there that a proxy reported as loopback is asked for the key once (the
  banner's "anywhere" link carries it).
- **The receiver answers a browser on its own pages, and on its own machine under its own
  names.** Before any route is reached, a request the browser marks as coming from another
  origin is refused (403 `cross_site`); a link from another site to a page of the board
  still opens, and pages are sent with `frame-ancestors 'self'`, so the board is not shown
  inside another site's frame (an editor's built-in preview is one). A request made on the
  machine that runs the GUI must name it by a name the GUI hands out or was given (403
  `unknown_host`, with a page that says where to go): `localhost`, any address and the
  `<name>.local` secure address are known, and `--allow-host NAME` adds another, such as
  the machine's hostname or an `/etc/hosts` alias; `http://0.0.0.0:7373` is not one, open
  `http://localhost:7373`. The public url is answered through its proxy. This covers every
  route, uploads and deletes among them. Sinks, the daemon, the desktop and phone apps and
  the CLI send none of what is refused and work as before. A reverse proxy on this machine
  is answered once `--public-url` names its address and it sends `X-Forwarded-For`; one
  over plain http must pass on the `Host` it was asked for.

## [0.8.4] - 2026-11-17

The iPhone app on a spacesheep account, refined: every screen agrees on whether the
phone can send, a prompt can be answered for as long as it waits, and an answer shows as
sent everywhere; long messages open whole, the board holds still while an account
catches up, and connecting says what happened in one line.

### Changed

- **A list row offers Allow and Deny only beside a request it shows whole.** The Inbox
  cut a command to one line, on a phone often before its target, with a one-tap Allow under
  it. A short, whole request now wraps beside Deny and Allow; anything else, a plan
  included, takes at most two lines and offers Open, which opens the session where it is
  shown whole. The row's menu and the a and d keys answer only a request shown whole, and
  the keys never answer a session open beside the Inbox unless the focus is in it; a board
  row's menu answers only one its line does not cut. Every shell prompt reads "Allow Bash
  to run:" (its own shell's name in place of Bash) with the command under it, at every
  size, and no "?" is left alone on a line after a command that wrapped. A command of one
  line is shown whole however it wraps, also on a phone, where it was cut at three lines.
  A Claude Code command over 120 characters, which reaches the app cut with no mark, is
  shown whole where the session sends its calls' input, and otherwise ends in "…".
- **A session's subagents open under it on the board only while one of them runs.** A
  tree whose agents had gone quiet opened by itself; it stays folded now, and the row says
  only how many run. On a phone an open tree lists the agents at work and one row, "Show n
  finished", for the rest (a search lists the finished ones it found). A tap on the row's
  leading 44 points, its glyph included, folds the tree; the title opens the session. On a
  touch screen a tree's rows are 44 points tall, and no tree hides one agent behind "Show
  1 more".
- **On a touch screen, Return in a session's message field starts a new line.** The
  iPhone's keyboard has no Shift+Return, so a message could not be more than one line, and
  a stray Return sent half of one. The ↑ button sends now, as in Messages, and ⌘Return
  (Ctrl+Return) from a keyboard; an iPad with a keyboard attached works the same way. A
  computer keeps Return to send and Shift+Return for a new line, however narrow its window.

### Fixed

- **A session's tools line says "Asking to run Bash" while the agent waits for your
  answer, not "Running Bash".** Claude Code asks before a tool runs, yet the line spun and
  the tool's time kept counting under the Allow it waited for, twelve minutes on. A tool
  spins and counts now only while its session works. While the session asks, the line
  reads "Asking to run" and the tool, with the needs-you dot, and once your answer is out,
  "Running" again; when nothing has come for ten minutes, "Bash · quiet for 12 m", with the
  quiet ring; on a computer that is offline, its ring stands still and it shows no time.
  A row that shows no time gives its command the room the time took. A subagent's tools
  follow the subagent; a stopped turn stops them, unless the subagent works on in the
  background. "· 2 more tools", which read as tools still to come, is gone, and the words
  start at the same place whether a tool runs or the turn is over.
- **A question from Claude Code reads as the question, not as "Allow AskUserQuestion?".**
  Its row showed only the tool's name, and its card offered Allow and Deny, neither of
  which can carry the answer. The card now shows the question and its options to read,
  and says to answer it on its computer; the board and the Inbox show the question after
  "Question". The Inbox lists it with the prompts waiting in a terminal and treats it as
  one: the Inbox badge doesn't count it, a browser tab raises no notification for it, and
  its card, its rows, their menus, the palette, the banners in the app and, on a spacesheep
  account, the iPhone's notification offer no answer.
- **An answer to a prompt shows as sent on every screen, in one line: "Allowed · waiting
  for" its computer.** Only the screen it was pressed on knew it went: the Inbox, the
  session's page and a reload offered Allow and Deny again, and a second tap cost a Face ID
  and came back "already answered". The prompt's card keeps its question and says which
  answer went, and what it waits for, in place of the buttons, the note and the row under
  the field; its glyph turns while it waits. The Inbox row says the same, and the badge and
  the count drop the moment the answer goes. An answer the computer refuses gives Allow and
  Deny back, with why, in the Inbox and on a banner only on that prompt's own row. A
  disabled Allow no longer looks like the one pressed, and VoiceOver hears why Allow, Deny
  and Start are off.
- **On a phone, the link under the message field reads as an action and takes a finger's
  tap.** "Approve this iPhone", "Unlock now", "Retry now" and "Open on spacesheep.dev" were
  the grey of the sentence beside them, on a line 18 points tall. They are the orange of
  the app's other actions now, bolder, and 44 points tall to a finger, without taking a tap
  from the field above or from Ask another agent… beside them; the line itself is a size
  larger. New session's Discard draft is orange and 44 points tall too, and Cancel still
  keeps the draft. VoiceOver and Voice Control name the field by the words it shows
  ("Message this session…").
- **In the phone app nothing shows through the tab bar, the navigation bar or the session's
  control strip.** The bars were meant to blur what ran under them and never did: rows read
  sharp through the tab labels and into the home-indicator strip, and the transcript
  through the session's title and the command waiting for Allow or Deny. The bars are
  solid now.
- **Connecting a spacesheep account on the iPhone: "Use it" is the answer the question
  offers first.** Back from Safari, the question put Cancel first, and one tap on it threw
  the connect away and left a key behind on spacesheep. It now names the account in its
  title ("Use you@example.com?") and where it is signed in, and offers Use it first.
  Cancel stays first where a yes would remove another account here (the question says
  which), and Disconnect's button is red.
- **Coming back late after confirming is no longer called "Not confirmed in time".** The
  app asks spacesheep once more after the code's time and takes its word: an approval it
  still holds is collected, and one it dropped is said, with the key left there to revoke.
- **Each way a connect can end says what happened in a title and one line.** "Not now" on
  spacesheep reads as the person's own choice, not a refusal; another open question,
  "Time ran out" and "Couldn't connect" have titles of their own; and where a key was left
  on spacesheep, the screen says to revoke it once, with "Open API keys" to do it.
- **A busy session's row shows the newest words of its reply, and no longer says "waiting
  for 25703 events" on a spacesheep account.** spacesheep relays a session thinned on
  purpose, so the numbers it skips are events that were never sent; the row and the
  session's page read them as missing, and the count only grew. A row's flag now takes at
  most part of the line instead of pushing the reply out, only a slow tool or a loop is said
  there (compacting is on the session's page), and a reply still being written starts at
  its newest sentence, not at a word cut 300 characters back.
- **A permission prompt is no longer greyed out as "raised before this machine was
  paired".** On a spacesheep account almost every prompt older than a minute said so, with
  Allow and Deny off, though the computer was paired long ago. Allow and Deny now stay for
  as long as Claude Code waits for the answer, two minutes. After that the prompt says "Too
  late to answer from here; answer it on" its computer, with no buttons, moves to Waiting
  in a terminal in the Inbox, and no longer counts on the Inbox badge. One that was gone
  already reads "already answered, or timed out". A line that stands on its own reads as a
  sentence, whatever the computer's name starts with, and a name such as
  Misha-Petrov-laptop no longer breaks at its hyphens.
- **Once the iPhone is approved on a spacesheep account, every screen agrees that it can
  send.** Machines kept offering "Approve this iPhone", and New session and the composer
  said a computer did not trust the phone, until the app was opened again: the app had
  read its own key before the ask made it, and never read it again. It reads it again
  after the ask, when the approval is first seen and when the app comes back to the
  front; and on an account, what spacesheep says about the phone decides on every screen.
- **A phone approved before the app saw it wait is no longer said to wait an hour.**
  Settings › App said "This iPhone can send by" an hour from then when, say, the app's
  storage had been cleared. It says "Can send" now; if spacesheep does hold a send back,
  its answer says until when.
- **On a spacesheep account the board holds still while the app reads the account's
  history, and says "Catching up…".** The iPhone app drew the board from part of the
  history every second and a half, oldest first, so for its first minute the same sessions
  read as Done, then as needing you (with a badge), then as Working. The board on screen
  stays as it was, or its loading rows on a first connect, and changes once, when the
  history is in. Nothing it hands over for notifications comes from the part read so far.
  Meanwhile a prompt it kept has Allow and Deny off, and nothing says to pair a computer
  that is paired.
- **Long messages and long replies are no longer cut at 400 characters.** A session
  opened again showed a message you sent cut mid-word, with no sign of it, and every reply
  over 400 characters as a stub that needed its own "Load full text". Both now arrive whole
  up to 2,048 characters, the newest reply always whole, and a message sent from this
  device as it was signed. A long message folds to eight lines under "Show all"; an older
  reply longer than that ends in "…" with "Show more".
- **Machines on a spacesheep account says in one row whether the iPhone can send, and calls
  a computer offline when the board does.** Each computer listed its devices by key ids
  ("Kq3mZ7wP, wDOATr0O (this one)") with an "Approve this iPhone" link of its own, and read
  "online" while its sessionpipe was down, as long as a session there still sent. One row
  above the computers now says where the iPhone stands ("This iPhone can send from 5:26
  AM") and opens Approve this iPhone; each computer has Status and Sessions on a line each,
  a line only where something is so (an old sessionpipe, a computer that has not approved
  the iPhone, inherit mode), and the rest behind Details. On every Machines page a paired
  machine is online only while its sessionpipe is.
- **An iPhone that isn't approved offers Approve this iPhone instead of an Allow that would
  only be refused.** Allow, Deny, Send and Stop asked for Face ID twice, then failed with
  words about a day grant. A prompt now says "This iPhone can't answer yet." with Approve
  this iPhone in their place, the field is off, and the Inbox says it once, in a panel above
  Notifications, as it says the hour and any other reason Allow and Deny are off; the Mac app
  does the same where a computer doesn't trust the Mac, on that computer's prompts only (in
  the Inbox, on their rows), while another computer's keep Allow and Deny. Where a computer
  has not added an approved phone's key, Allow and Deny stay, off, the prompt says so once,
  with Approve this iPhone, and that page says to add it on spacesheep's Devices; a refused
  send takes one Face ID and says why.
- **In the app, nothing warns of Face ID ahead of time, and a cancel is not an error.**
  Every session said "The first send today asks for your passkey. Unlock now" on the
  iPhone, and New session and Ask another agent each had a note of their own. Now the first
  Allow, Send, Start or Ask of the day just brings Face ID up (Touch ID on the Mac). While
  it is up the line says "Confirm with Face ID…", never Touch ID on the iPhone. A
  cancelled Face ID or passkey leaves everything as it was, typed words included, with no
  "not sent". In a browser a cancelled Unlock now brings the line back, and a refused one is
  said until a send goes. Every refusal reads "Not sent: …", in the Inbox too.
- **In the hour after the iPhone is approved, Allow, Deny, Send and Stop wait instead of
  asking for Face ID only to be refused.** The app held them back only when it had seen the
  approval come within 20 seconds, which a trip to Safari to approve it never is, so the
  first tap got spacesheep's three-sentence refusal. An approval seen within ten minutes now
  counts, and a send that is still refused says "Not sent. This iPhone can send from 5:26
  AM." The hour is said once: with a prompt open, on its card with Open on spacesheep.dev
  (on the phone the card stands alone, and the link takes a line of its own), else under
  the field. The Inbox says it as it is, without "Allow and Deny are off:" in front. Every
  screen says it in the same sentence, full stop included, and "by 5:26 AM at the latest"
  where only the latest time is known.
- **New session and Ask another agent offer nothing that would only be refused.** On an
  iPhone that isn't approved they were a whole form with a faded Start and a grey footnote;
  now each says "This iPhone isn't approved yet" with Approve this iPhone, and a message
  written earlier is still there once it is. In the hour after approval the form stays and
  Start waits under "This iPhone can send from 5:26 AM." instead of costing a Face ID, and
  once the hour is over no refusal from it is left on the sheet. A computer that hasn't
  added the iPhone is listed, off, as "not approved", and New session opens on one that can
  start. When all is well the phone's sheet says nothing under the form, the Permission row
  stays and reads "Safe" in the ink of the other values, and an agent's allowance shows
  under its name only at 20% or less, never as a bare "Reset".

## [0.8.3] - 2026-11-16

0.8.2 was tagged and never published (its Apple builds could not be made that day); what
is listed under it below ships in this release, with three fixes to the iPhone app on a
spacesheep account.

### Fixed

- **Trying to connect a spacesheep account with no signal no longer locks connecting for an
  hour.** The app counted every try against its limit of three an hour, also one that never
  left the phone: three taps with no connection, and the fourth said "Too many tries".
  A try for which no connection could be made is not counted now, for connecting and for
  asking spacesheep to approve the phone. A try that may have reached spacesheep counts
  as before.
- **What spacesheep says when it refuses the phone's request arrives as it wrote it.** Its
  sentence lost every character outside plain ASCII on the way to the page ("Turn on Talk
  to your sessions in Settings  Account"): quotes, arrows and letters of other alphabets
  are kept now, in one plain line.
- **An account in Settings › App › Receivers is named by its email and reads as connected
  when its key is in place.** It was named by its host and read "not connected" until
  something had been asked of it since the app opened.

## [0.8.2] - 2026-11-16

### Added

- **The iPhone app's own screens for a spacesheep account.** The first run offers "Use a
  spacesheep account" under the ways to a computer: a number to compare, a page in Safari
  to confirm on, and the board, with each way it can go wrong said with what to do next.
  Settings › App
  shows whose account it is, where, since when and how it stands, connects again when its
  key was refused, and disconnects, saying first what that removes. "Approve this iPhone"
  lets the phone send: it asks spacesheep, shows the number to type on its Devices page,
  waits, and says from when the phone can send (a newly approved device waits an hour).
  A phone that cannot sign yet says so in one line and leads to the session on spacesheep.
- **The app's page can show a spacesheep account with no GUI server behind it.** With the
  app's half (the account's key and its doors) and the screens that connect one (the entry
  above), the phone keeps its own board from the account, shows it again at the next launch
  before anything is read, and sends through spacesheep as the desktop app does. A message
  whose answer is lost on the way back is never called not sent: the phone says it may have
  been sent, holds that session's next send, asks again by itself, and then says which it
  was. A session the account forgets leaves the phone too.
  Disconnecting removes the account from the phone: its key, its sessions, labels and read
  marks, drafts and recent searches; the key itself keeps working until it is revoked on
  spacesheep. Nothing changes for a browser, the desktop app, or the phone on a receiver.
- **The iPhone app's own half of a spacesheep account.** The account's key is kept in the
  iPhone's keychain, on this device only, and never reaches the page: the app itself asks
  spacesheep for the number to compare, opens Safari, and keeps a key only after its own
  alert names the account and is answered. It carries five requests for the page and
  nothing else: the relay, its machines and jobs, a signed command to a computer, and this
  phone's own key. A command is signed with Face ID by the phone's key in the Secure
  Enclave, for the account's own host only. A send is called not sent only when nothing of
  it left the phone. A session that needs you posts a notification while the app is still
  awake in the background. Not on Android yet, and not in the desktop app, which reaches an
  account through its own server.

### Fixed

- **A usage report that names its account or its machine with more than a line of text is
  not kept.** An account id or a machine name past 200 characters (no sender makes one)
  went into the limits list, its file and every frame at any length.
- **A send to a computer reached through spacesheep outlives a restart.** Its row was
  deleted when the app started, because such a computer is never saved here: a start
  waiting for an offline computer then read "No such session here", and ran anyway when the
  computer came back. The row is kept, followed again once the account is read, and settled
  by spacesheep's word on the job. A row the connected account can't speak for (another
  account) is settled as one this app can no longer follow, and offers no "Edit and start
  again", since it may still run there. Disconnecting, or starting without an account,
  leaves the rows waiting and marked as not followed; the same account connecting again
  picks them up. While spacesheep refuses this app's key the waiting rows are marked so
  too, rather than reading "Waiting for …" with nothing being read.
- **A start waiting for a computer through spacesheep is no longer given up after an hour.**
  The app called it expired on its own clock ("didn't come online in time", with "Edit and
  start again") while spacesheep kept it for a day and still handed it out, so starting it
  again meant two runs. Only spacesheep's word on the job settles it now; a job it still
  lists as waiting, or no longer lists, is called expired here only an hour past
  spacesheep's day, when spacesheep can no longer hand it out. The job list is read past a
  job that waits for days, so a newer send's word is never out of reach. A send the
  computer took and said nothing more of (spacesheep keeps it "running") ends past that
  day as `unconfirmed` and is no longer read, rather than "Starting…" for ever. A job's
  age is spacesheep's: its own `created_at` against the time spacesheep's answer carries,
  so a clock here that jumps ends nothing early; with no time from spacesheep, the send's
  own time on this clock. A send closed for want of word (`unconfirmed`, or `untracked`
  while another account was connected) is settled after all when spacesheep later lists
  its job as finished: an untracked one waits again when its account connects, an
  unconfirmed one is read once more then and when events arrive for its session.
- **Waiting sends through spacesheep are read for at a slower pace.** The job list was read
  every 3 seconds whatever the send waited for (about 200 reads in 10 minutes, now for up
  to a day). While every waiting send is queued for a computer the machine list shows
  offline it is read every 45 seconds (about 13 in 10 minutes), and at once after a send,
  when that computer shows online and when events for that session arrive; every 3
  seconds only while a send is taken, just made, or its computer is online.
- **A refusal through spacesheep keeps its reason.** Where spacesheep's job list says why a
  job ended (`code`: the computer's own refusal code, `cancelled`, `expired`), the row takes
  it, so the words for a folder, a permission level, a start limit or a model are the ones
  a computer reached directly gets, and a start that ran out reads as one that expired.
  Against a spacesheep without the field nothing is guessed from its note.
- **No attachment is offered for a computer reached through spacesheep.** A start's file
  stayed on this app's disk, spacesheep looked for it in its own store and refused the
  start, and the person was told to add the file again. The new session sheet no longer
  offers files there, and a session's message box offers images only when that computer is
  this one (the block names files on this disk), until there is a way to carry one. A
  send that names files for such a computer anyway is refused here (code `relay_files`),
  never carried to spacesheep.
- **Events spacesheep no longer holds are reported as a gap.** The gap was noted only when
  a page came back empty, but spacesheep answers everything after the cursor that it still
  holds, so an app that was off longer than spacesheep keeps events (7 days, 50 000 events)
  lost the middle and said "reading". It now says "gap" whenever the first event back is
  not the one after the cursor, and keeps saying it while it runs.
- **A send that spacesheep refuses because this app's key was revoked there is no longer
  mistaken for the page's own key.** spacesheep's 401 was passed on as it was, which a page
  reads as "this page lost its key". It now comes back with its own code, and Settings →
  Data says the key was revoked at the same moment, not at the relay's next poll.
- **When spacesheep asks this app to slow down (HTTP 429), the app waits as long as it
  says** (its Retry-After, at most 15 minutes) and its state is `limited`, no longer
  `offline`, which Settings → Data read as "can't be reached".
- **A steady stream of events no longer freezes the board for minutes.** The reader asked
  spacesheep once per event, reached its limit (240 reads a key in 10 minutes) in about
  four minutes at one event a second, and then waited out the rest of the window. It now
  keeps count of its reads in the last 10 minutes: under a third of its budget of 230 it
  reads at once; past that it waits between reads, a little more as the budget is spent,
  so a stream is read in batches about 3 seconds apart (at most about 4 seconds behind)
  and never meets the limit. The machine list is read every minute on its own, so it
  stays fresh while the reader waits. The count is kept beside the cursor (every 15
  seconds and at stop), so a restart in the middle of a stream goes on from it; with none
  on file a third of the budget is taken as spent.
- **What spacesheep says of a send is shown as plain text, and a send it took without saying
  which job it is does not wait for ever.** The note on a job spacesheep carried (a
  computer's reason for refusing, say) reached the page as it came: with line breaks,
  characters that reorder text, any length. It is shown as one plain line now, with what
  cannot be seen taken out, and whole: up to the 500 characters a computer may send, with
  nothing cut short of that and nothing added, so the sign-in link of a pooled account on
  such a computer arrives as the computer wrote it. That link is offered only when it
  reads as an `https:` address; anything else is treated as no link. A code that is not
  written as one is no longer passed on. A signed command
  that is not a command is refused as a bad request instead of an error. And when
  spacesheep takes a send but names no job (a job is one only as a whole number), its row
  says "Sent, but this app can't follow it. Check spacesheep.dev to see how it went."
  rather than waiting on a job that cannot be read, and rather than saying a computer took
  it, which is not known. A handoff's card no longer says "not sent" of a send whose end is
  not known: it says what is known ("no word · rc-mac took it and said nothing more", or
  that it is not followed).
- **Words, plain**: a start called off before it began reads "Cancelled before
  rc-mac started it." and a message sent to it "Cancelled with its session, before rc-mac got
  it."; a refusal with no specific reason "rc-mac refused it." plus the receiver's reason when
  there is one, never "refused: refused"; a file for a computer reached through spacesheep
  "Files can't be sent to rc-mac through spacesheep yet." (plus "Remove them to start." for a
  start edited again that carried files, and "Not sent." in front when a send carried one); a
  revoked key "Not sent. spacesheep no longer takes this app's key: disconnect and connect
  again in Settings → Data."; a send this app can no longer follow "Sent through a spacesheep
  account that's no longer connected here. Check spacesheep.dev to see if it started."; a send
  the computer took and said nothing more of "No word from rc-mac since it took this. Check
  spacesheep.dev to see how it went."; a send waiting while spacesheep is disconnected "Not
  being followed while spacesheep is disconnected." (while its key is refused, "Not being
  followed: spacesheep no longer takes this app's key."); Settings → Data, limited, "this app
  is reading too often for spacesheep; it catches up by itself"; the activity line of a
  cancelled start, "cancelled · before the machine started it"; an offline computer through
  spacesheep is waited for "within a day".

## [0.8.1] - 2026-11-12

### Changed

- The server's store reads its full events through a log it is handed (the session files on
  disk, as before, or events held in memory), and nothing it imports needs Node, so the same
  store can later run in the phone app's page. Nothing changes in what the GUI shows or keeps.
- Checking an incoming event's id and tier no longer loads sessionpipe-core's Node code for two
  rules: the receiver keeps a copy of them, and a test holds the copy to sessionpipe-core
  0.13.6, so it runs in a page too. Events are accepted and refused exactly as before.

### Fixed

- **`service install` restarts a receiver that is still running an older copy of itself.**
  After `npm i -g` put a new sessionpipe-gui over the old one at the same place, the
  service's file already named the new files, so `service install` said "already running
  0.7.2" and left the old process running the old code; the page, newer, then called
  routes that server did not have ("HTTP 404" under Settings › Data › spacesheep). It now
  restarts it and waits for this version to answer ("updating … 0.7.2 → 0.8.0"), on macOS,
  Linux and Windows. A receiver on the port that isn't the service's own (one started by
  hand while the service is down: its `run.json` names a pid that isn't the service
  manager's, or on Windows a command line that isn't the task's) is left alone, with a line
  that says so; a receiver that couldn't write its `run.json` counts as the service's when
  the manager says the service runs. When the new
  version doesn't come up after the old one was stopped, it says so on stderr and exits 4.
  An older sessionpipe-gui no longer quietly replaces a newer service that runs from
  somewhere else (the version read from the `package.json` beside the service's CLI): it
  says so and leaves it, unless `--downgrade`; nor a service that runs a developer's
  checkout (a folder with `server/cli.ts` or `.git` beside `dist/`). A re-install with other
  `--port`, `--state` or `--host` by the same CLI or a newer version works as before. One
  `service install` or `uninstall` runs at a time (the lock is
  `service-<label>.lock` in the default state folder, `~/.local/state/sessionpipe-gui`;
  a crashed run's is taken over), and a `bootout` that finds the job already gone counts as
  stopped. `--if-installed` acts on a service that is there, installs none, never moves one
  to an older version, and exits 5 where it did nothing.
- **A receiver reports the version it is running**, read once when it starts. It read
  `package.json` on every request, so one whose package was replaced under it answered
  `/api/ui/info` with the new version while it ran the old code, and nothing could tell it
  was stale. `service install` takes the version from `run.json` (written once, at start),
  so it also restarts a receiver of 0.8.0 or earlier that answers with the wrong one.
- **The desktop app brings an older receiver on this computer up to its own version,**
  downloading nothing without a click. An app that updated itself kept talking to the
  receiver it had, which still ran the version that installed it. Once per launch, when
  this computer's receiver (the one its `run.json` names) first connects and runs an older
  version than the app: where a `sessionpipe-gui` on PATH is at the app's version or newer,
  the app runs its `service install --if-installed` in the background (the service upgraded
  in place, with its port and state folder; none installed where there was none). Where only
  the app's own release through `npx` would do, that is a download, and nothing runs: the
  app's log says so and Settings › Data offers it as a click. A failure before the old
  receiver was stopped leaves it running; one after it (exit 4) is logged as that, and an
  `--if-installed` that did nothing (exit 5) is logged as nothing done. "Start sessionpipe"
  and the click prefer the app's release through `npx` over an older CLI on PATH. The click
  runs a `sessionpipe-gui` on PATH only when its version is known and at least the app's;
  when `npx` can't download it (offline, GitHub blocked), or there is nothing that could,
  it changes nothing and says so. "Start sessionpipe" uses the CLI on PATH instead only
  where that can't make the service older (no service installed, or a CLI at least the
  version it runs). The app runs one install at a time. An install still downloading when
  the app stops waiting (180 s) is stopped: on macOS and Linux with what `npx` started, on
  Windows `npx` alone. One whose `sessionpipe-gui` has begun is never killed: the app stops
  waiting and says it is still finishing, keeps reading what it prints until it ends, and
  logs how it ended.
- **In the app, an option the receiver is too old for says so** instead of the receiver's
  "HTTP 404". Settings › Data › "Use a spacesheep account" against a receiver older than
  0.7.5: "sessionpipe on this computer is 0.7.2, which is older than this option." with
  Connect… off, an **Update sessionpipe** button (the app's release through `npx`, with its
  progress line), and the command to copy. When the update stopped the old receiver and the
  new one didn't come up: "The update didn't finish, and sessionpipe isn't running right
  now. Press Update again." with the log's path under it; any other failure: "Couldn't
  update it. Press Update again, or run the command below." with the installer's line under
  it. An update already running when Settings opens shows as working. "This computer" is
  the receiver the app's launch check found to be this computer's, not any loopback
  address; any other is "… Update it there." The version is read again after the update,
  when the connection comes back and when the window comes forward; a notice that a 404
  brought stays until another receiver process answers. Only the receiver's own 404 counts (not the app proxy's for a receiver it doesn't
  know), and a version that isn't below the option's is left out of the sentence. A page
  the receiver serves itself never says it. On a phone a sentence over a command (this one,
  and About's update command) stays in one column.
- The help and the authoring guides call what `view`, `skin` and `plugin link` make a link,
  not a symlink: on Windows it is a junction where a symlink needs Developer Mode.
- **On Windows, "Start sessionpipe" looks for Node only in absolute folders.** After PATH
  it tries folders under `ProgramFiles`, `APPDATA`, `LOCALAPPDATA` and `USERPROFILE`, and
  `NVM_SYMLINK` itself. A value there that is not a full path (`nvm`, `.`, an unexpanded
  `%NVM_HOME%\nodejs`) was looked up from the folder the app was started in, so a
  `node.exe` under that folder could be the one it ran. Such a value is now left out, as a
  `.` on PATH already is (#101); `ProgramFiles` then reads as `C:\Program Files`.
- **`sessionpipe-gui service` on Windows starts `schtasks`, `taskkill` and PowerShell by their
  full paths** under `%SystemRoot%\System32`. They were started by bare name, which is looked
  for first in the folder the command is run from, so a `schtasks.exe` lying there would
  have been run in their place. The commands it tells you to type name them in full too.
- **A `!NAME!` in the state folder's path is kept** where the registry turns cmd's delayed
  expansion on: the Windows task now runs the receiver through `cmd /v:off`. Without it cmd
  puts a variable's value there when NAME is one that is set (`C:\data\!OS!\state` became
  `C:\data\Windows_NT\state`), and the receiver was started on another folder. A task that
  0.8.0 installed gets the new line the next time `service install` rewrites it (a new Node
  or package path, a changed option, or a receiver that is not running), or at once with
  `service uninstall` then `service install`. A 0.8.0 `sessionpipe-gui` does not know a
  task with the new line as its own: remove it with this version.
- **`service uninstall` on Windows takes the `\sessionpipe\` folder out of Task Scheduler**
  with its last task, where it left it there empty; one that 0.8.0 left goes on the next
  `service uninstall`. The folder stays while another task is in it, and where PowerShell
  is held to constrained language mode, which cannot remove it.
- **`config.json` is kept readable by you alone.** Node applies a write's mode only when it
  makes the file, so a `config.json` that already existed with looser bits (recreated at the
  shell's umask after deleting `uiKey` as SECURITY.md says, for example with
  `jq … > tmp && mv tmp config.json`, or copied back from a backup) kept them while it held
  the sink token and the UI key. The GUI now takes the group and other bits off before every
  write, as it already sets its TLS keys to 0600 when it writes them, and also when it
  starts; where that fails it says so and starts anyway.
- **A message that is held for you to confirm can be sent.** When spacesheep's safety check
  holds a message to a machine paired there, the page now says so where you sent it: the
  message, spacesheep's reason in its own words, and a "Confirm with your passkey" button. It
  goes only when you press that button; change the message first and the hold is dropped.
  It used to say "try again", and every try was held the same way, so such a message could
  not be sent from the GUI at all.
- **Child sessions stay under their parent when the GUI restarts.** A session started by
  another one (a subagent) was counted as its parent's child while the GUI ran, and every
  restart forgot it: the parent showed no children and the agent row for that child no
  longer opened the child's page, until the child sent something new.

## [0.8.0] - 2026-11-11

### Added

- The receiver keeps three things a sessionpipe 0.13 machine says. `inbox` among a
  machine's delivery modes and as the mode of an ack, which it used to drop as a word it
  did not know: the line under a message a live session took through its own inbox now
  reads "delivered · inbox" ("taken · … · inbox" on the way), where it read "delivered"
  with no mode. The other two are kept for the pages that will show them, and nothing
  draws them yet: the session a copy answered for (an ack's `copy_of`,
  `ControlActivity.copyOf`), and whether the command line is signed in to each account (a
  hello's `signed_in`, `HarnessAccount.signedIn`).
- **`sessionpipe-gui service install` on Windows.** The receiver runs in the background as a
  scheduled task that starts at your logon (`\sessionpipe\dev.spacesheep.sessionpipe-gui`
  in Task Scheduler), with no console window and no administrator rights; `uninstall`,
  `status`, `--dry-run` and the in-place upgrade work as on macOS and Linux, and the output
  goes to `<state>/service.log`. Until now it said "a background service on Windows is not
  here yet".

### Changed

- **sessionpipe 0.13.6.** The receiver verifies commands with sessionpipe-core 0.13.6 (it
  was 0.10.0), pinned to that one version. "Bring the answer back" in the Ask another agent
  sheet now sends: a machine whose hello says `handoff` used to get "Not sent: this
  receiver's sessionpipe is older than bringing answers back", because this receiver's own
  verifier refused `reply_to` before the machine saw it. That line is gone from the sheet;
  a command the verifier does refuse with the switch on reads there as it does on any
  send. A pool command is verified by the core itself, and still refused here on a day
  grant alone where the machine wants a fresh confirm.
- sessionpipe's conformance fixtures for 0.13.6 (169 control vectors, 33 delivery scenarios)
  are in the repo under `test/conformance/` and run with `npm test`, in CI too. They were
  read from a sessionpipe checkout beside the clone and skipped without one, so CI never
  ran them, and with one the pool vectors failed (#71).

### Fixed

- **A `session.seq` above 2^53 − 1 is refused**, the schema's bound: the receiver answers
  `bad_seq`, and the outbox reader and the demo drop it. Two such seqs in one session hung
  the GUI server at 100% CPU while it listed the hole between them; a store an older
  release already wrote them into now boots instead of hanging.
- **One session file the outbox can't read no longer stops the outbox.** A file the GUI
  may not open (its mode, another user's) or a folder named `*.jsonl` made the first read
  fail, and no session from the outbox reached the board while that file stayed so,
  restart or not; one that turned unreadable while running kept every older session from
  being read and the offsets from being saved, with a line on stderr every 500 ms. That
  file is now skipped for the tick, said once, and read on from its offset once it can be
  read again.
- **Setup's "Pair this machine" works on Windows.** The receiver ran `sessionpipe.cmd` through
  cmd.exe, which never handed its output back (the step sat at "Starting the pairing…") and
  split a folder with a space, such as `C:\Users\Ann Lee\code`, into two words. It now runs the
  script the npm shim names under its own node, with no shell, as it does on a Mac.
- **Setup speaks Windows.** On a Windows receiver the secure-address step pointed at
  `brew install openssl` and gave Debian and Fedora commands for trusting the certificate; the
  pair step's button said "Pair this Mac". It now names Git for Windows' openssl (or winget),
  gives `certutil -user -addstore Root ca.crt` and the Install Certificate… steps (also on the
  trust page and from `sessionpipe-gui tls trust`), and the button says "Pair this machine"
  off a Mac.
- A self-assigned 169.254 address (no DHCP answered on that link) no longer comes first among
  the receiver's LAN addresses, so the Machines page's pair command, Connect and the phone
  link name an address the other device can reach.
- **A virtual adapter no longer comes first.** Windows' "vEthernet (…)" switches (WSL 2,
  Hyper-V), VirtualBox and VMware host adapters, and Linux's libvirt, LXD, Incus, LXC,
  Multipass and Podman bridges sort after the real interfaces, whatever their case, so the
  phone's QR code, Connect and the `sink add` command name an address the other device can
  reach. No address is dropped: a Hyper-V external switch keeps the host's LAN address on
  "vEthernet (External…)", after any real-named interface.
- **`--host 127.0.0.1` (or `::1`, `localhost`) no longer offers LAN URLs nothing listens
  on.** The banner listed every LAN address as a `network` URL, its phone QR and the sink
  command pointed at one of them, and a bind to `::1` gave a sink command on `127.0.0.1`;
  all of them refused connections. A loopback bind now offers no LAN URL, and the sink
  command names the address it bound, under "from this machine"; a bind to one LAN
  address lists that address alone as its network URL.
- **A `config.json` that does not parse is never written over.** A `config.json` left empty or
  half-written by a write that died, or hand-edited so it no longer parses, was silently
  replaced with fresh secrets on the next start, so every sender paired with the old sink
  token got 401 and every phone and browser holding the old UI key was refused, with nothing
  said. The GUI now stops with a message that names the file and what to do, and leaves it
  byte for byte as it was; one it cannot read (a folder of that name, no permission) stops
  it the same way instead of with a stack trace. A `config.json` with a UTF-8 byte-order
  mark (PowerShell 5's `UTF8` encoding, older Windows editors) is read past it, instead of
  being replaced the same way. `sessionpipe-gui search` and `index` read the history setting
  past a byte-order mark too, and stop the same way on a `config.json` the GUI refuses,
  instead of reading it as history on.
- A plugin turned on with `sessionpipe-gui plugin enable` while the receiver runs starts
  on Reload plugins, as the CLI says. And a plugin or view the CLI turns on or off
  while it runs is no longer undone by the receiver's next write of config.json (a token
  rotation, a toggle in Settings, a spacesheep connect), which put back the lists it held
  in memory.
- **`npx github:spacesheep-dev/sessionpipe-gui` works on Windows.** Its one-time build
  spawned a bare `npm`, which is `npm.cmd` there and can't start without a shell, so the
  command exited 1 with no message. The build now runs npm through npm's own entry under the
  same node, and says why if npm can't be started. Its check for the build tools also looked
  for `@vitejs/plugin-react/package.json` through the package's exports, which leave it out,
  so on every platform the tools were installed a second time; on Windows that install ran
  the build script again, and again, until the PATH outgrew cmd.exe.
- **The desktop app on Windows tells a stale receiver from a live one.** It decides whether
  the receiver that wrote `run.json` still runs by its process id, and on Windows that check
  always said yes. It now asks Windows, so a file left by a receiver that has stopped is no
  longer taken for the one that dropped. The hand-run Desktop workflow also passes on
  `windows-latest`: its `npm ci` skips the prepare build, as desktop-release does, two tests
  no longer assume macOS, and the four that run a shell script are compiled on Unix only.
- **The desktop app's first-run sheet speaks Windows and Linux.** The New session shortcut
  reads Ctrl+Alt+N there (it read ⌃⌥N, the Mac's symbols, everywhere), as does the
  recorder in Settings › App; the sheet says sessionpipe is in your system tray, not your
  menu bar; and a refused notification points at Windows' Settings, not System Settings.
- **The desktop app's welcome and tray say "this computer" off a Mac.** On Windows and
  Linux the welcome offered to start sessionpipe on "This Mac" ("so this Mac's sessions show
  up here", "Nothing leaves this Mac"), and the tray listed an unreachable local receiver as
  "This Mac". A Mac still reads exactly as before.
- Search no longer says "“c:” isn't a filter" over a pasted Windows path (`C:\Users\…`,
  `D:/repo`) or a URL (`https://…`). They were, and still are, searched as text; the notice
  now stays for something that looks like a filter, such as `foo:bar` or `cwd:/x`.
- **The tier lens shows prompts, turn ends and attentions as a lower-tier receiver gets
  them:** under a lens below tier 3, who submitted a prompt (`submitted_by`, `injected`)
  and the background work still running when a turn ends (`background`) now stay, and an
  attention's `turn_id` and `call_id`, which the client never sends, go, as does its
  `agent_id` at tier 0.
- Board filters apply immediately even while focus or the pointer holds the row order.
- **Search shows a message just indexed at once when the indexer runs inside the server.**
  Where the indexer cannot be forked it runs in the server's own process, and there a
  request to commit that arrived while an earlier commit was being published was dropped:
  the new messages then waited for the timed commit, up to a minute. The forked indexer
  never dropped one.
- **Turning history search off works on Windows.** With Node 20, Settings › Data answered
  "internal", left the history index on disk and stopped the indexer until the GUI was
  restarted: the server still had that index open while it deleted it, which Windows
  refused. It now lets go of it first. If another program still holds a file of it, the
  setting is saved anyway, indexing goes on, and the status is an error naming the index
  left on disk until a later try (the indexer's next start, or Rebuild) deletes it.
- **A Windows file is listed once.** A full path from Claude Code on Windows
  (`C:\Users\…\acme\src\index.ts`, with either slash or the drive in another case) is shown
  relative to the session's folder, as `src/index.ts`, as on a Mac, so the Files drawer, the
  Review page and the changed-files count no longer give one file a row for each
  spelling of its full path.
- **`view`, `skin` and `plugin add` and `link` work on Windows.** A .zip is unpacked with
  the tar.exe Windows ships instead of failing with "unzip is not installed"; an npm
  package or a git URL runs npm's own script under the GUI's node instead of failing with
  "npm is not installed" while npm is on PATH; and `link` makes a junction where Windows
  refuses a symlink, so it no longer fails with EPERM when Developer Mode is off.
- **A finished session stays finished.** A sender records a hook when it gets to it, so a
  tool call that fired just before a turn's Stop can be recorded after it; the receiver
  read that late event as a new turn, and the session went back to "working" (then
  "stale") until its next prompt. An event from before the last end of the turn, or of the
  session, now takes nothing back: it is filed and counted, and the session stays idle or
  done. The same for an agent whose start is recorded after its end, and for the end of a
  run recorded after the session started again. Only an event timed within two seconds
  before that end is read so (the furthest a hook was found recorded behind, on a real
  machine, is 1.3 s). Further back than that it is the sender's clock that moved: a clock
  that stepped back, a session resumed where the clock is behind, or a batch from a clock
  ahead of the receiver's is read in the order it was recorded, so a running session never
  reads idle or done because of its clock.
- **A page that was away shows what is true now.** After the live stream dropped and came
  back, an open session page kept the events it had: a turn still drawn as running, a
  message still "handing it over", a reply missing, until a reload. The page now reads
  what it missed, once, when the stream is back, with nothing redrawn, the scroll where it
  was and the draft in the composer kept. A tab shown again after a long time hidden, a
  page restored by Back, a laptop awake again and a network that returned all ask for a
  fresh stream instead of trusting the old one, and coming back online no longer waits
  out a retry timer.
- While the stream is down a session page stops its spinners and its clocks where they
  were, as the board's rows do, and the page counts as live again when the fresh state
  has arrived, not when the connection opens: nothing reads as running, or can be sent
  or stopped, on what the page knew before.
- An event that arrived in the instant a session page finished loading no longer goes
  missing from its timeline.
- **One conversation, drawn once.** A message sent from a session's page and the turn it
  became are one block, in the cases where they were two or the wrong one. A message
  handed to a terminal session at its turn's Stop (sessionpipe 0.13.4) is its own exchange
  after that turn, "Turn 4, continued": it used to take the typed turn's place, so the
  typed prompt and its reply were gone, or, when that turn had begun over a minute
  before, to be drawn again at the end for two minutes. A prompt the machine scrubbed a
  secret, an email address or a phone number out of, and any message to a machine whose
  clock is behind, is its turn (both showed twice while the turn ran). A refused or
  expired message no longer takes a later turn that says the same words, which drew the
  refusal on a turn that ran; and a machine whose clock is ahead no longer hides it. The
  turn after one that was stopped keeps its own words, which were drawn on the stopped turn.
- **A stopped turn reads as stopped.** After Stop the turn stays where it was, with what
  it had written and a quiet "Stopped" where a running turn says "Running"; one stopped
  before it wrote anything says "Stopped before the first word.", and so does a message
  stopped before its turn began, which read "Delivered. Its turn shows here when it
  begins." The daemon's "(The turn was cancelled.)" and Claude Code's "No response
  requested." are never shown as what the agent said, a turn stopped at its terminal no
  longer shows the raw word "interrupt" beside a duration that ran to the next prompt, and
  a tool call the stop cut off no longer spins.
- **The desktop app's "Start sessionpipe" finds Node on Windows.** It looked through a login
  shell and for `node` and `npx` in Homebrew, nvm and Volta folders only, so on Windows it
  always said "sessionpipe needs Node 20 or later". It now reads the app's own PATH, then
  Program Files, `%APPDATA%\npm`, nvm-windows, Volta and Scoop; runs the scripts behind
  npm's `.cmd` shims under node; and starts them with no console window. It takes only the
  absolute folders of PATH, for the search and for the PATH it hands the installer, so a
  `.` there is never where it finds `node.exe`. The button then runs `sessionpipe-gui
  service install` (the scheduled task above) and opens the board. Opened again, the app
  finds the receiver on this computer (it looked for it only under HOME, which Windows
  doesn't set, and showed the welcome instead).
- **The Windows app's updater reads update archives with `zip` 9.5.1** (it was 4.6.1), which
  has the fixes for an archive whose two headers disagree writing files outside the update
  folder (GHSA-m665-v7pm-7grj, CVE-2026-115905), a symlink target that aborts extraction or
  exhausts memory (GHSA-q7v9-x93c-xqv3, CVE-2026-115909), and an AES entry passing its HMAC
  check when the file ends early (GHSA-8hxf-qr8p-62x4, CVE-2026-115906). It comes with
  `tauri-plugin-updater` 2.14.1, whose own code is unchanged. The macOS and Linux apps never
  read update archives with `zip`.

## [0.7.5] - 2026-11-06

### Added

- **spacesheep as the backend (an option).** Settings → spacesheep connects this GUI to a
  spacesheep account: the GUI asks for a code, the account's page shows the same four
  digits, one confirm, and from then on the account's sessions and paired machines arrive
  here through spacesheep's relay, no receiver of your own to host. The machines paired
  there show on Machines as remote ones; a message to one of their sessions goes through
  spacesheep's jobs door, signed by the app's own device key, which "Approve this app on
  spacesheep" asks to be trusted (approved once per machine on spacesheep's Devices with
  the two-digit number the app shows). How each send went (delivered, refused, why)
  settles from spacesheep's word. Not a default: a GUI that never connects works as before
  (docs/rfcs/08).

### Fixed

- The desktop release workflow retries `stapler staple` and `stapler validate`, which
  Apple's ticket service failed twice in a row with the dmg already notarized.

## [0.7.4] - 2026-11-03

### Added

- **Sending from the iPhone app.** The phone app signs with a device key in the iPhone's
  Secure Enclave, Face ID (or the passcode) on each send, the same signer as the Mac app's:
  "Add this iPhone" on Machines makes the key, a passkey approves it once per machine on
  the computer's Devices, and from then on the phone answers prompts and sends messages
  like the Mac. Until now the phone said "Sending from this phone comes in a later
  version", and "Add this iPhone" met the plugin's ACL.

### Fixed

- **The pairing link the terminal prints carries the board's key** (`&k=…`), so a browser
  that never saw this board opens it and is let in, instead of "This board needs its key";
  the pair page also draws itself as a QR for the phone that holds the passkey.
- **The app says it can't approve its own key**, and hands off to the browser or phone
  that holds a trusted passkey, instead of "not sent · the machine doesn't trust this Mac
  yet" on its own request.
- The iOS release workflow reads altool's verdict ("UPLOAD SUCCEEDED") rather than failing
  on a transient status-poll error on the way.

## [0.7.3] - 2026-11-03

### Fixed

- **The pairing link the terminal prints names a passkey origin.** `sessionpipe control
  pair` printed the address the daemon reached the GUI on (a tailnet IP, a LAN name), and
  a page on that address can neither read the board without its key nor make or use a
  passkey, which belongs to the https host or to localhost. The link now names an origin
  passkeys work on: the daemon's own when it is one, else the first. Seen pairing a Mac
  mini with the GUI on a laptop: the printed `http://100.68.187.81:7373/pair` link met the
  key wall, then "Sending works from https://…; open it there".

## [0.7.2] - 2026-11-02

### Fixed

- **Files shows the text of a file the agent read.** Claude Code hands a Read's result
  to its hooks as an object (the file's lines, from the line it started at), and the
  drawer only knew the numbered text older builds sent, so every file the agent only read
  said "Nothing to show yet", and an edited one showed its edits with no text around them.
  Both forms read now, and the edits apply to the text they changed.
- **The app says "confirm with Touch ID" only when Touch ID will ask.** With the day's
  grant held, an answer or a message is signed with the day key and no sheet comes, but
  the app said "confirm with Touch ID" while it signed, so a slow send read as a Touch ID
  prompt that never showed. It now says so only for a confirm, a fresh grant, or when no
  grant is held, as the browser does.

## [0.7.1] - 2026-11-02

### Fixed

- **A harness that a program starts and stops no longer fills the board.** An IDE that
  probes its provider (bb's `provider-maintenance-workspace`, for one) starts Claude Code
  and stops it without a prompt, many times a day, and each probe was a row: untitled,
  "unattended", under Idle or Done. A session nothing has happened in (no turn, tool,
  subagent, prompt or ask) that is unattended or has already ended now stays off the
  board, the palette, and the folders and agents New session, Ask another agent and a
  workflow step offer, until its first turn; its end is no longer news. The receiver
  keeps it, so its page and Search still find it. A terminal someone has just opened
  stays on the board, so its first message can come from here.

## [0.7.0] - 2026-10-31

### Added

- **The phone's first run.** With no computer connected yet, the iPhone and Android
  apps open on the lockup and three ways in: scan the code under Connect on your
  computer (a full-screen viewfinder; the camera is asked for only then), enter its
  address, or try the demo. A code the app can't use, a refused camera, a computer out
  of reach and the TLS code's trust page (open it in Safari, come back, Connect) each
  get one plain screen. Once the board is up, one sheet says the step left: the
  computer approves this iPhone once, where that is in the computer's own labels, "Ask
  <computer> to approve" (which files the request) and Later.
- **Files beside a session.** A Files button on the session's bar (and the panel's head,
  `⇧F`, the "⋯" menu) opens a drawer of every file the session read or changed, from the
  events it already sent: the receiver's index of the whole session
  (`GET /api/ui/sessions/:harness/:id/files`, the same reading the Review page makes) and
  the live events since; nothing is asked of the machine. The list is the repo's tree, by
  folder, each file with what happened to it and when; a filter narrows it; a file can be
  marked viewed.
- **A file's changes, its text, and every version.** A file opens on its **Changes**: the
  lines taken out and put in against the text the agent last read, the rest folded past
  three lines of context and opened in place; **Text** is the whole file as it stands,
  rebuilt from its last Read or Write with the Edits after it applied in order and the
  lines they wrote marked (hover one for the edit that wrote it). Every Read or Write the
  agent made is a version, one step away. Edits the text cannot hold (a patch, a page of a
  big file, a notebook cell) read as hunks. The page's `?file=<path>` opens the drawer on
  one file; "Copy link to this file" writes it.
- **Comment on a line to ask for a change.** Click a line number (shift-click, or ⇧↓, for
  a range) and say what should change, or **suggest a replacement** for the lines; a
  comment can be on the whole file. The comments gather at the drawer's foot and go to the
  session as one review message (`path:line`, the lines quoted in a fence tagged by the
  file's language, "Replace with:" for a suggestion, a per-item reply asked for), the same
  signed `prompt` the composer sends, or into the composer to finish by hand. While the
  agent is mid-turn the button says the review is read when the turn ends. Afterwards the
  list says which files changed since your review.
- **Problems.** The drawer's second tab lists every tool that failed and every error the
  session raised, each a jump to its row in the timeline.
- **Open in editor.** Where the session runs on this machine, a file opens in VS Code,
  Cursor, Zed or Windsurf (the drawer's "⋯" chooses), at the commented line.
- **The drawer from the keyboard.** `⇧F` opens it with focus in the filter; ↓ ↑ (j k) move
  over the files and the lines, Enter opens a file or the comment on a line, n and p go to
  the next and previous change, Esc steps back (the comment, the file, the drawer) wherever
  focus is. Focus follows each step and returns where it was on close; over the timeline
  (the panel, a narrow page) what is under the drawer is inert meanwhile; a status line
  says what happened for a screen reader; forced colours draw the changes as borders.
- **Go to file from ⌘K.** `/` then a path finds any file changed in the last thirty days,
  across every session and machine (the Review page's reading); a query that reads as a
  path brings the files in beside the sessions. Enter opens the newest session that touched
  it, on that file; a file several sessions touched asks which (›); ⇧↵ opens it beside.
  On a session's page, "Files of this session" toggles its drawer.

### Changed

- The phone's Settings › App no longer shows the Mac's rows (the Dock badge, keeping
  the app running with the window closed) or names System Settings; the device key's
  rows and the device request say "this iPhone" / "this phone".

### Fixed

- The phone app at tablet width (an iPad): the rail's head and the page bar start under
  the status bar, and the compose glyph no longer pushes the mark off the rail's edge.

## [0.6.2] - 2026-10-30

### Added

- **Pull down to refresh** on the phone's list pages (Board, Inbox, Search, Feed, Review,
  Machines), as a native list does: a ring draws in the tint as you pull, a tick as it
  arms, and the stream reopens for a fresh snapshot. While the stream is down the same
  pull is the retry.
- **The phone's tint.** The sessionpipe orange on the selected tab, the back chevron, a
  sheet's Cancel and Start, a switch that is on, the text-size slider, the caret and
  links. Needs you keeps its own orange; everything else stays graphite. Skins may set
  `--tint` and `--tint-fg`.
- **The phone app feels native.** Taps and outcomes play the phone's haptics; the status
  and navigation bars follow a forced Light or Dark (or a one-scheme skin); the edge swipe
  goes back on iPhone and the back button goes back on Android instead of closing the
  app; the session's message bar rises above the keyboard on iPhone.
- **Push and pop.** Opening a session from a list slides it in as a native push and Back
  slides it out, the tab bar staying put; the back button names the page it returns to.

### Changed

- The phone's tab bar and bars are translucent material, as iOS's are, with the page
  blurring under them (solid under Reduce Transparency).
- Rows highlight under the finger and release as native cells do; an empty Inbox or Feed
  centres on the screen.
- **The phone names the device it runs on:** "Approve this iPhone", "Face ID signs what
  you send" (on Android "this phone" and "your fingerprint") everywhere it said "this
  Mac" and "Touch ID".
- On the phone an Inbox row, and anything that opens a session "beside", opens the
  session's own page, pushed with Inbox behind Back, instead of the desktop's panel as a
  sheet; the panel is never restored on the phone at launch.
- A dropped stream on the phone is said under the large title ("Reconnecting · 3 s ·
  Retry") instead of a pill over it; the pill stays only on pages without one.
- With a permission pending on a machine the phone isn't paired with, the session's dock is
  the Allow and Deny card alone with one hint, and a command moves to the next line whole
  with its question mark.
- In the phone app the Inbox's notification banner and bell read the app's own permission
  ("Notifications are off · Turn on", or "Open Settings" once refused), and the empty
  Inbox no longer talks about "this page" or "your phone".

### Fixed

- Notification banners on the phone fit the screen on every title length and sit under
  the status bar; a long one ends in an ellipsis instead of running off the edge.
- **Every scrollbar on a desktop is the app's own**: a thin grey thumb on no track, the
  window's and the popovers' included (the Mac app showed the OS's), and the Display
  popover can no longer scroll sideways.
- **The Add account sheet is New session's dialog**: 640 px under the title bar over a
  scrim that dims the whole window, Cancel and Sign in in its footer (in the top bar on a
  phone), the command and the sign-in as grouped rows. It had taken the Usage page's
  reading measure and left the sidebar undimmed.
- **"Sign in to Claude…" on a machine whose pool is off turns the pool on first**, then
  opens the sign-in, and says so, instead of being refused with "the pool is off on that
  machine".

## [0.6.1] - 2026-10-30

### Added

- **The Mac app updates itself.** Settings › App › Updates has "Check for updates
  automatically" (on by default: 10 s after launch and every 6 hours), the version you have,
  "Last checked 5 min ago" and Check now. A newer release is downloaded in the background
  and verified against sessionpipe's key; then "0.7.0 is ready" with **Install and relaunch**
  in Settings and the menu bar item. "Check for Updates…" in the app menu runs the same check
  and, with no window open, answers in a dialog: up to date, ready to install, or why it
  failed. A failed check says so in plain words (offline, no manifest, no build for this
  computer, a signature that doesn't match) and leaves nothing half-installed.

### Fixed

- **`service install` upgrades the service it finds instead of refusing.** The app's
  "Start sessionpipe" (and the command) used to stop at "a service is already installed"
  whenever an earlier version had installed the LaunchAgent / systemd unit, which is every
  upgrade of the app. Now a service of ours under the label is rewritten in place with this
  version's node and cli (its port, state dir and options kept unless flags say otherwise),
  restarted (`launchctl bootout` + `bootstrap`; `systemctl --user daemon-reload` + `restart`),
  and waited for until the new version answers: `updated dev.spacesheep.sessionpipe-gui: 0.4.1
  → 0.6.0`. The same service answering already is `already running 0.6.0 on …` (exit 0); one
  still starting is left to it. A plist under our label that runs something else is still
  refused, as is another program on the port. `--dry-run` shows the rewrite and the restart.
- **A big board gets time to start.** The installer waited 10 s for the receiver and then
  printed what read as a failure, while a 1 GB state dir takes ~30 s to index at boot. It now
  waits up to 90 s (`SP_SERVICE_WAIT_MS`), says what it is waiting on ("starting on :7373…
  283 sessions to load; a big board takes a minute"), and a service that is running but not
  answering yet ends with "still starting", exit 0. The desktop app shows those lines on the
  welcome ("Updating sessionpipe 0.4.1 → 0.6.0…", "Starting… this can take a minute on a big
  board") and waits as long itself.
- `service uninstall` no longer says "still loaded" on the first call: `launchctl bootout`
  returns before the job is gone, and the command now waits for it (as the upgrade's
  restart does before it bootstraps again).
- `service status` prints the running receiver's version beside the pid.
- The Windows installers build again: `icons/icon.ico` is in the bundle's icon list, where the MSI
  bundler looks for it.

## [0.6.0] - 2026-10-29

### Added

- A session another session launched (`session.launched_by`, sessionpipe 0.10.0) says so in its
  header with a link to the launcher, and the launcher's header links what it launched. Neither is
  read as a subagent: no nesting, no muted toasts, no "N subagents" count.
- **A paired machine you rely on that went offline** gets one quiet line at the top of the
  board: "build-box is offline, last heard 14:02. 2 messages wait until it's back.", with
  Machines beside it. Only a paired machine with a message waiting or a session that needs
  you, works or went stale counts; one that only sends events has no heartbeat and is never
  called offline. × hides the line on this device until something changes: it clears
  itself when the machine is back, and a new drop brings it back.
- **Since you looked.** An idle or done session with news you haven't seen (a turn ended
  or the session ended since you last had it open) draws its glyph filled in, in ink, and
  the folded Done header says "3 unread". Opening it for a second, as a page or the
  panel's tab, marks it read on every device. A turn you typed at the terminal of a
  session you attend is not news; working, needs-you and unattended rows are never
  unread, and nothing from before the first run is.
- **Mark as read / Mark as unread** in an idle or done session's menu and the phone's
  long-press sheet, `u` on the board's cursor, and **Mark all as read** in the board's
  view menu. The marks live in `<stateDir>/marks.json` (`GET` / `PATCH /api/ui/marks`, a
  `marks` frame on every change); a forgotten session loses its marks.
- **Notify me, per session.** Every session's menu (and the phone's long-press sheet) has
  **Notify me**: When it needs me, as before; **When it needs me or finishes**, which
  also sends "Deploy billing finished" with its last answer each time it has news and is
  idle or done (a click opens it); or **Never**, which sends no notification, banner or
  sound for it while it still waits in Needs you and the Inbox. A row set to Never shows a
  small bell with a slash. A parent session can quiet its subagent sessions, never make
  them louder. The choice is kept in `marks.json` (`notify`), so it holds on every device;
  the browser's permission, the global Notify me and sounds stay per device.
- **A New line where you left off.** A session with news since you looked opens with a
  quiet "New" hairline above the first answer you haven't read, in Simple and Advanced
  and on a phone. When there's more than a screen of it, the session opens with the line
  a third of the way down instead of at the bottom. Your own turns at the terminal never
  count, the line doesn't move while the page is open, and it's gone when you come back.
  A session you haven't opened yet opens at the bottom as before.
- **Hidden sessions can be found again.** The board keeps what this device hid in a
  **Hidden** group after Done, folded like Done and under the same filters; its rows are
  ordinary rows, and **Unhide** (the row's menu, `e`, a phone's trailing swipe) puts one
  back in its state's group.
- **Hide until it needs you**, below Hide in a row's menu (or `⇧E`), for a session that
  loops ("every 30 minutes, check the nightly build"): new turns leave it hidden, and it
  shows only while it needs you. `e` hides or unhides the row under the cursor.
- **How much each account has left.** A Usage page, a line per account in the sidebar, and
  each agent in New session say how much of its 5-hour and weekly windows is left and when
  they reset, from sessionpipe's `limits.observed`. Claude Code's week is "This week, all
  models"; a per-model week it adds later shows as its own row ("This week, Fable only").
  A window past its reset says so instead of its last number, and a report older than 15
  minutes says how old. On a machine whose agent has two accounts there is no number, since
  a start can't choose one. Claude Code's numbers need its status line, on Pro and Max:
  `sessionpipe install --status-line`. Harnesses with no source say so in one line, never
  0%. `g u` opens the page; the sidebar lines can be hidden in Settings › General.
- **Several Claude accounts on one machine.** A machine whose sessionpipe pools accounts
  (`sessionpipe pool`, 0.11) says so in its hello, and the GUI reads the pool: the accounts
  in the machine's order, which one is in use, which is used up and when it is back, which
  needs signing in again, and each one's freshest numbers on the Usage page even while it is
  idle. Turning the pool on or off, reordering, enabling, disabling, removing and refreshing
  an account, and signing a new one in, are signed `pool` commands through the same channel
  as everything else, verified here before they are carried; a machine whose hello has no
  pool is told so before anything is queued. A session the pool moved to another account
  says which one serves it and since when, and its chat shows the switch. Demo mode has a
  machine with the pool on, one with an account in error, and one with the pool off.
- **Agents that use agents.** sessionpipe's next release lets a session ask another agent
  on its machine (`sessionpipe ask codex "…"`) and lets a receiver hand a task to an agent
  with the answer brought back into a session (`reply_to` on a signed `prompt` or
  `start`). The GUI reads the two events, `delegation.started` and `delegation.ended`, into
  the session (`delegations`, `delegatedBy`, `counts.delegationsRunning`), keeps a session
  working while an ask is open, and shows a capability only where a machine's hello says
  `ask` or `handoff`, so a 0.10 daemon keeps working as before.
- **Ask another agent…** on a session's page (the control strip, its menus, a reply's
  right-click "about this…", ⌘K, ⇧A): one sheet, prefilled with the last reply, that asks
  an existing session on the same machine or a new one of a harness the hello lists, with
  "Bring the answer back into this session" where the machine takes handoffs. The asking
  session shows the row at once.
- **Lineage.** "Asked Codex · new session · running 1 m 20 s" where the ask happened in the
  chat and the timeline, the answer folded under it or drawn as that agent's turn when it
  was brought back; the asked session's bar says "for <parent>" with a link; the board nests
  it under its parent; Machines says "Agents here can ask each other"; the Feed and the
  Activity page word the events and the handoff.
- **Workflows** (`/workflows`, `g w`): chain and fan out steps across your agents and
  machines (implement → review → fix; two agents in parallel, a third compares). Three
  templates, an editor of native rows that saves itself, Run with the input it names, and
  a run view with every step's state, elapsed, reply and session. The server owns a run
  (`workflows.json`, `workflow-runs.json`, moved by control's acks); the browser is only
  the signer, from any device that can sign, with claims as the guard across tabs. A
  browser signs the runs it started on its own; one started elsewhere asks once ("Sign
  here"), so nothing on the loopback or another site can set your passkey to work. The
  signed command goes back through the run itself, queued only once the server has seen
  the step is still that tab's: a step cancelled or re-offered mid-signature queues
  nothing, and one the receiver refuses fails in place instead of being offered again
  every minute. A step is never signed without the level or model it names when the
  machine's hello does not offer it; the run says so. Every write to `/api/ui/workflows`
  is JSON only, an empty POST too, and refuses a cross-site request.
- **Demo mode** plays an ask and a handoff on lab-mac, whose hello now says `ask` and
  `handoff`; the mock stream has the same.

### Changed

- **A chained shell command reads one step per line** on a session's permission strip:
  "Allow Bash to run:", then `npm run build`, `&& npm test -- bm25`, `&& npm run deploy …`
  each on its own line, so nothing wraps mid-token before you answer. Quotes, `$( … )` and
  groups stay whole, a pipeline is one step, and a short command stays on the question's
  line. The command is the call's own, whole, when the session sent it; otherwise the
  first 200 characters the machine sends, ending in "…". Four steps show, then "Show 2
  more lines", and Deny and Allow keep to the question's line. On a phone a longer one
  scrolls inside, cut through a line, so you see there is more.
- **A plan review reads as a plan.** When Claude Code asks to leave plan mode, the strip
  asks "Ready to start on this plan?" and shows the plan under it (at tier 3), eight lines
  until **Show the whole plan**, with **Approve plan** and **Keep planning** where Allow and
  Deny were; `a` and `d` are unchanged. Keep planning carries what you type in the composer
  ("What should change?") to the agent as the answer's note, and Enter there sends it.
  While the composer holds a note, Approve plan waits, so the note is never dropped: send
  it with Keep planning, or clear it. The row menus, the command palette and the Inbox
  name the same two answers, and the tool reads Plan.

### Fixed

- **The row menu says "Allow Shell"** (and Deny), as the strip and the Inbox do, not
  "Allow run_shell_command".

## [0.5.0] - 2026-10-28

### Added

- **sessionpipe for Android** (`apps/mobile`, formerly `apps/ios`): the iPhone app's
  Tauri shell now also builds for Android, with the same bundled UI. It connects to your
  computer by its address or phone link (asking first, in the system dialog), shows the
  board and sessions live, follows the system's dark mode, and draws edge to edge clear of
  the status and gesture bars. Sending from a phone comes in a later version, on both.
- **A phone's welcome** offers your computer and the demo; a phone runs no sessionpipe of
  its own, so the "This Mac" row is gone there.
- **Phone releases.** *Android release* builds the Android app for a tag (arm64, armv7,
  x86_64; about 11 MB on arm64), signs it with the upload key and checks the signer,
  attaches the `.apk` to the draft release and uploads the `.aab` to a Google Play track. A
  *Mobile* check builds both phone apps on every PR that touches them. RELEASING.md has the
  steps.

### Changed

- **iOS → TestFlight, end to end.** The build runs on Xcode 26 (App Store Connect refuses
  builds from older SDKs since April 2026), checks the `.ipa` before uploading it (ids,
  numbers, SDK, signer, profile, privacy manifest), uploads to the app by its Apple ID with
  the App Store Connect API key, and passes only once App Store Connect has processed the
  build, with the TestFlight link in the summary. Without a tag it is a dry run of the
  branch. The app carries a privacy manifest (no tracking, no data collected).
- The phone apps are called **sessionpipe** (they were "sessionpipe Dev").

### Fixed

- **TestFlight builds** set `CFBundleVersion` to the run number alone. Appending it to the
  version (`0.4.1.12`) gave App Store Connect four numbers, and it takes at most three.

## [0.4.1] - 2026-10-27

### Fixed

- **Approving the Mac app says how.** Its page names the two ways: open Machines in the
  browser that holds your passkey (a link opens it), or run `sessionpipe control pair` on
  the machine and approve it in the app with Touch ID. "Sign with Touch ID" is now
  **Approve this Mac**, and a composer on a machine that doesn't trust this Mac yet says
  what approving does.
- **A passkey prompt that never shows** no longer leaves Approve spinning in the browser:
  after eight seconds the row says where the passkey may be and what else to try.
- **Setup in the app.** Step 2 no longer asks for passkeys on the app's page (Touch ID
  signs there; the https address is the phone's), so the sidebar's Setup dot can clear.
  Step 3 is done only once the paired machine trusts this Mac, with Approve this Mac until
  then.

## [0.4.0] - 2026-10-27

### Added

- **sessionpipe 0.10.0.** A machine in `inherit` mode (no permission flag: its agents run
  as your own sessions there do, whatever their settings allow) shows as that, with one
  line saying what it means, on Machines, the pairing page and the New session picker,
  never as safe or auto; the well-known says `control.inherit: true`, so a 0.10.0 machine
  may pair or switch to inherit with this receiver. New session there defaults to "As your
  own sessions on this machine", which is sent as no level at all, and offers Read only
  and Safe; nothing wider is offered or queued there, and `inherit` is never signed. An
  ack's `applied: inherit` reads "As your own sessions".
- **A session waiting on its own background work** (`turn.ended.background`) stays
  working, "waiting on 2 background tasks", until it wakes, instead of going idle.
- **Unattended runs** (`session.attended: false`): a short one is drawn quiet on the board
  ("unattended"), and no unattended run raises a banner or a notification; absent is
  unknown and changes nothing.
- **Who submitted a turn** (`turn.started.submitted_by`): a scheduled, loop or system turn
  says so under its prompt and on its row while it runs; an injected turn (a task
  notification) never becomes the row's last ask.
- **Accounts named by host** (an API home, `api.z.ai`): kept from the hello's `accounts`
  without an email and listed on Machines.
- **ACP agents**: labels and monograms for the ACP registry's harness names, Machines lists
  what a daemon can start, New session offers them with no permission or model pickers,
  and a start delivered over `api` says "Ran on …" with its reply.
- **Demo mode pairs two machines**: studio-mac on 0.10.0 in inherit mode (goose among its
  agents, an api.z.ai account, a start it ran over ACP) and build-box on 0.9.0, and plays
  background work, a scheduled turn and a short unattended run.

### Changed

- The hello's `home` is gone (0.10.0 sends none). A start's folder may be `~/…` where the
  machine's hello has `start` and this receiver's sessionpipe-core takes one (feature
  detected, `server/control/tilde.ts`); otherwise folders stay absolute, from the
  machine's `folders`.
- The receiver's second look at a command follows 0.10.0: the closed field set per kind,
  files on a prompt only for a machine that says `prompt_files`, and a level at most Safe
  on an inherit machine. A hello keeps up to 64 harnesses.
- **The Mac app sends.** The macOS release carries its Touch ID signer: a key in the
  Mac's Secure Enclave signs new sessions, prompts and permission answers, from the window
  and from a notification's Allow, Deny and Reply. Set it up once with **Sign with Touch
  ID** (on Machines, a session's composer or Settings › App › Signing): a browser or phone
  the machine already trusts approves the Mac with its passkey, and then one Touch ID a
  day unlocks sending. It needs a receiver whose sessionpipe-core verifies device keys and
  a machine that takes them (sessionpipe 0.10). The release needs no new entitlement.

- Where the app can't send, it says exactly why, with the next step: this build has no
  signer (Linux, Windows, a dev build), the receiver can't check the Mac's key yet (update
  sessionpipe-gui), the machine predates device keys (update sessionpipe there), or the
  Mac isn't set up for that machine yet (Sign with Touch ID). Notifications offer Allow,
  Deny and Reply only once the Mac holds a key for that receiver.

## [0.3.2] - 2026-10-27

### Fixed

- **The desktop app opens on the receiver it finds.** 0.3.1 found a receiver already
  running on this Mac and selected it, but kept the window it had opened with none, so the
  board stayed on its first frame for good. Selecting a receiver now rebuilds any window
  that doesn't show it; the same fix covers the welcome's Start sessionpipe and Connect.
- The board and the inbox never sit on loading rows without saying why: after a few
  seconds they say they're still connecting, or that the connection is down, with Retry
  now. A stream that opens but never sends its first update is opened again.
- The desktop app gives up on a receiver that accepts the connection and never answers
  (20 s), and writes dropped streams and failed requests to its log (no keys, no queries).

## [0.3.1] - 2026-10-27

### Fixed

- **The desktop app finds a receiver already running on this machine.** On a first launch
  it went straight to the welcome, even with a receiver on :7373; it now looks (the
  default port, then the receiver's `run.json`) and opens on it.
- **The welcome's Start sessionpipe works.** It asked npm for `sessionpipe-gui@<version>`,
  which isn't published, and failed with E404; it now runs the same version from the
  GitHub release tarball.
- When the board's filter finds nothing, it says what it looked at and offers to search
  every session for the words.

## [0.3.0] - 2026-10-26

### Added

- **New session.** One compose sheet, from anywhere: `c`, the compose glyph beside the
  sidebar's name (top right of Board and Inbox on a phone), the palette ("New session…",
  "New session on studio-mac…", "New session in acme/web"), right-click a session for
  *New session here*, a machine for *New session on …*, a folder on Machines for *New
  session in this folder*, the empty board's "Start a session on …", and
  `?new=1&machine=&harness=&cwd=`. Machine, agent and folder (recent folders under one the
  machine allows, then the allowed ones, then a typed path, checked by whole path
  segments), the message and files; Permission and Model only when the machine's
  sessionpipe advertises them (0.10), one muted line when it does not. A machine that
  cannot take a start from this page stays in the list with its reason; an offline one can
  be chosen and queues. The draft is kept per device until it is sent or discarded.
- **The started session opens live.** Start goes straight to the new session's page,
  which shows the message, then "Sent to", "Starting on", the reply as it grows, and turns
  into the ordinary live session at its first event; what the machine ran it with
  ("Accept edits · sonnet") sits in the bar. A refusal says why in place, with *Edit and
  start again*. The board shows the start as a row at once.
- **Files on a new session** (CONTROL.md §3.1, HTTP.md §3): `POST /api/ui/control/files`
  holds a file under its SHA-256 and `GET {control}/files/{sha256}` serves it to a paired
  machine's token; the well-known says `control.files`. Nothing about a file goes into the
  text the agent reads.
- **The receiver reads sessionpipe 0.10's start options**: the hello's `start`, `home`,
  `files`, `prompt_files`, and an ack's `applied`; it refuses before queueing a start that
  asks for what the machine did not advertise (`permission`, `model`, `file`,
  `bad_fields`).
- `ThemeApi.control.compose(prefill)` opens the sheet from a view.
- **Search.** Every session from one field, as you type: what the receiver holds from
  every machine, and this machine's own agent history read from the harness logs (Claude
  Code with subagents and forks, Codex `.jsonl` and `.jsonl.zst`, Antigravity, Gemini
  CLI), even sessions from before sessionpipe. Prompts, replies and one line per tool call
  are indexed; tool output, thinking and anything the harness redacts are not. Our own
  index in TypeScript, no new dependency: BM25F with recency, phrases, prefixes,
  `-exclusions`, camelCase and path tokens, folded diacritics and CJK; a niced child
  writes it crash-safely and incrementally, and a live tail finds a new line in about
  50 ms. One query language (`"phrase"`, `-word`, `pre*`, `agent:` `machine:` `repo:`
  `since:` `until:` `in:prompt` `label:`) for:
  - the Search page (third in the rail, `⌘⇧F`): results per keystroke grouped by session,
    filter chips that edit the query, Best match or Newest, keys (`⏎`, `⇧⏎`, Space to
    peek, `j`/`k`, `⌘C` copies the resume command) and a right-click menu;
  - `⌘K`, whose *In transcripts* group previews the matched moment;
  - a read-only transcript for a session the receiver never saw (`/s/<harness>/<id>`),
    with a find bar and its resume line;
  - the terminal, with no browser: `sessionpipe-gui search "…" [--agent] [--machine]
    [--repo] [--since] [--newest] [--json]` and `sessionpipe-gui index
    [--rebuild|--status|--verify]`;
  - `/api/ui/search/*`, behind the UI key.

  History indexing is on by default and can be turned off in Settings › Data, which
  deletes that index; `--search-home` points it at another home.

- **Desktop apps.** A macOS app (universal, signed and notarized, about 4 MB) and Linux
  builds (AppImage, .deb) around the same UI, made with Tauri 2: it connects to the receiver
  on this machine, keeps a menu bar item and a Dock badge for what needs you, notifies,
  launches at login if asked and updates itself from GitHub Releases. It does not sign yet:
  sending from the app waits on device keys in sessionpipe, and until then it says to send
  from a browser. `sessionpipe-gui service install|uninstall|status` keeps a receiver
  running. Release buttons in GitHub Actions build, sign, notarize and publish it
  (RELEASING.md). An iOS build runs in the simulator and is not released.

### Changed

- **The sessionpipe brand.** The default skin is now **sessionpipe**: ink, graphite and
  paper neutrals, the brand's orange (#FF5A1F) as the one accent for *needs you* (the dot,
  the glyph, the Inbox badge, toasts, the canvas through the host tokens), a crimson for
  errors that never reads as the orange, an orange focus ring. Paper is re-tuned to the
  brand's warm paper. A device on Spacesheep moves to sessionpipe silently; the token names
  are unchanged, so views and installed skins keep working. Text is set in Geist and code in
  Geist Mono, self-hosted (36 KB for a page, the text face preloaded, metric-matched
  stand-ins so the swap moves no line). The sessionpipe mark and lockup replace the old
  tile: the sidebar, the rail, Settings › About, the favicon (SVG and ICO), the
  installed-app icons (maskable too), the touch icon, the link preview, the trust and 401
  pages, and the README's wordmark ([docs/brand.md](docs/brand.md)).
- **The board holds still under the pointer**: within a section rows keep their place
  while the pointer rests on the list (it re-sorted nine times in 20 s before), and rows
  that do move slide (FLIP). Layout shift on load 0.127 → 0.0005; exit motion is 140 ms
  everywhere, with one highlight at a time.
- **Lighter start**: routes and dialogs load when first used, so the entry bundle is
  140 KB gz instead of 232.
- **Type**: three weights, tabular numerals for counts and times, balanced headings, and
  each Linux desktop's own face before DejaVu or Cantarell.
- **The phone**: a two-line needs-you banner, one top-bar layout, swipe actions on rows.
- Tool names read as words ("github · search_issues"); the canvas view is the polished
  one from sessionpipe-gui-themes 0.3.0.
- The Machines page's inline start form is gone: the Control row has *New session…*.
- **Cancel the running turn** is `⇧C` now (`c` is New session).
- A dialog's Esc closes an open pop-up inside it first; a pop-up's filter takes focus once
  it is placed (it was missed on a desktop).

## [0.2.1] - 2026-10-24

### Security

- **One request could stop the server.** A path whose percent escape does not decode as
  UTF-8 (`/api/ui/sessions/%E0%A4%A/x`) threw outside the request's error handling and
  ended the process, before any key was checked, so anyone who could reach the port could
  do it. It is now a `400 bad_path` and the server keeps serving. A cookie value that does
  not decode (another app on the same host can set one, since cookies ignore the port) is
  read as it is instead of failing every request from that browser. Upgrade if the GUI
  listens on your network (the default).

## [0.2.0] - 2026-10-23

The native redesign: one window shell, grouped rows, right-click menus everywhere, and
ways to organise the work (colour labels, subagents you can watch, canvas views).

### Added

- **Colour labels.** Right-click any session, then "Label ▸", to give it one of seven
  colours; "Edit labels…" names them. A label is one dot wherever the session appears, the
  board and the feed filter by it (`label:red`), and every device sees the same labels.
- **Subagents you can watch.** A parent row says how many subagents run and opens a tree of
  what each is doing; the session page shows each agent under the turn that started it,
  with its tools and result; an agent opens beside its parent as its own tab.
- **Canvas views.** One click lays the canvas out by machine, harness, repo, state or
  label; *My layout* keeps your own areas and notes, the same on every device.

- **Your phone.** `/phone` (and setup step 4) gets a phone onto the board and sending from
  it in three steps, on the laptop and on the phone itself: the Wi-Fi QR; one recommended
  way to an https address the phone trusts (Tailscale in one click when it runs here, else
  the same Wi-Fi with the local CA, the iPhone and Android steps and a Check from the
  phone), the rest under "Other ways"; then "Send from this phone", six digits, one Approve
  on the laptop, no reload anywhere. A page on the wrong address (http://localhost while
  passkeys live at the `.local` name) now says "Sending works from https://…; open it
  there." instead of offering to add a device.
- **From anywhere.** `--public-url https://<name>` puts the GUI behind a trusted https
  reverse proxy on the same machine; the setup page's optional sixth step finds Tailscale,
  shows the `tailscale serve --bg 7373` line and sets the url in one click. The url's host
  is the passkeys' rp id, so one name works on the Wi-Fi and away; the proxy's
  `X-Forwarded-*` headers are trusted on loopback connections only, a visitor through it
  needs the UI key like any other device, and the setup actions stay for this machine.
  `Info.remote` carries the `sink add` and `connect` lines for a machine elsewhere;
  `--no-public-url` forgets it.
- **A phone in one read.** `GET /api/ui/phone` gathers what connecting a phone needs: the
  LAN QR, the rp id and the origins it is valid for (`Info.control.origins`, so a browser on
  the wrong address is sent to the right one instead of being asked for a new passkey),
  Tailscale's state, the trusted passkeys and the device requests waiting. One click
  (`POST /api/ui/phone/tailscale`, this machine only) runs `tailscale serve --bg` and sets
  the public url; a phone polls `GET /api/ui/phone/device/:id` while the laptop approves
  its passkey, and proves https works with `POST /api/ui/phone/trust-check`.

### Changed

- **A native app, not a web page.** One window shell (a sidebar and one title band), every
  list a grouped list of plain rows with a single status glyph, no cards; iOS-style large
  titles, sheets and tab bar on a phone. Fewer colours: neutrals, amber for needs-you, red
  for an error.
- **Right-click menus everywhere.** Session rows, tabs, messages, machines, paths and pages
  open a menu of their real actions (Shift+F10 or the context-menu key from the keyboard;
  a long-press opens the same items as an action sheet on touch).
- A delivered message whose turn is already in the chat folds to one line instead of
  repeating the reply; a background copy says "Copy of …" and links back, and the
  original's row links to the copy.

### Removed

- The built-in Plain, Graphite, Ink and Sepia skins and the bundled Spacesheep Vivid and
  Paper Serif: the GUI ships Spacesheep (the default) and Paper. A device that had picked
  one of them gets Spacesheep; installing a skin from elsewhere still works.

### Fixed

- "Claude is waiting for your input" no longer puts a session under "needs you"; it stays
  idle and the inbox does not count it.
- A message sent from the GUI showed beside the wrong turn (the second prompt read "hi")
  when two transcripts arrived together; transcripts now land on the turn their time falls in.
- A session that ended and started again (Claude Code resumed, a compaction restart, a
  harness reopened after a reboot) is live again on the board instead of staying "done".

## [0.1.0] - 2026-10-15

The first public release: a sessionpipe receiver with a face.

### Added

- **Receiver.** The sessionpipe HTTP binding (`/.well-known/sessionpipe`,
  `POST /api/sessionpipe/v1/events`) at every tier up to 3, with a bearer sink token;
  the local outbox tailed with zero configuration; `--demo` synthetic sessions and
  `--replay file.jsonl`. Scores 100 % on the upstream delivery conformance fixtures.
- **Store.** Append-only JSONL per session under `~/.local/state/sessionpipe-gui/`, an
  in-memory index rebuilt at boot, slim previews with the full event read back from disk
  by offset; `--keep-days`; *Forget* and `session.forgotten`.
- **Board, Session, Feed, Machines, Inbox, Review, Connect.** States `needs_you`,
  `working`, `stale`, `idle`, `done`; flags (slow tool, error streak, loop, compactions,
  sequence gap); Simple and Advanced modes; the tier lens; a split panel; the command
  palette; keyboard help and rebinding with vim and emacs presets; notifications, sounds
  and the installed-app badge.
- **Control.** A full control-channel receiver: pairing with six digits and a passkey,
  day keys, message, permission answer, stop, new session, images in the composer,
  `/add-device` for a phone, suggestions from plugins confirmed with a passkey.
- **TLS.** `--tls`: a local CA and certificate for `<machine>.local`, `localhost` and the
  LAN addresses, one port speaking both protocols, a trust page for phones.
- **Setup.** `/setup`: five live-detected steps for a first run.
- **Extensions.** Views (ES modules with `ThemeApi`), skins (tokens, fonts, shape, an
  optional stylesheet) and plugins (server-side, `PluginApi`), installed from a folder,
  archive, npm package or git URL; Canvas and Office bundled from
  `sessionpipe-gui-themes`; six built-in skins with Spacesheep as the default.
- **Extras.** Every official extension ships inside the GUI: Spacesheep Vivid, Paper
  Serif and ping-a-human bundled beside Canvas and Office (`dist/bundled/{views,skins,plugins}`,
  with a tracked copy in `bundled/` that `npm run bundle:sync` refreshes from the themes
  repo). `sessionpipe-gui extras list` is the catalogue with every entry marked bundled;
  bundled skins and plugins are listed after the person's own (an install of the same id
  overrides), cannot be removed, and are turned off with `skin|plugin disable <id>`. A
  bundled plugin is off until enabled: `plugin enable ping-a-human`, or Enable on the
  Views page (`POST /api/ui/plugins/:id/enable|disable`, loopback), remembered in
  `config.json` `enabled`.
- **Harnesses.** Every name in the protocol registry is known (Claude Code, Codex, Gemini
  CLI, Antigravity, Cursor, Copilot CLI, Droid, Kiro, OpenCode), with monochrome marks for
  the first five (Antigravity's official arch, Cursor's cube) and monograms for the rest;
  the setup page lists the harnesses installed on this machine with their hook state
  (`SetupStatus.harnesses`); a loop of identical tool calls is read from tool ends alone
  for a harness with no pre-tool hook (Antigravity); `--demo` plays Antigravity and Cursor
  sessions as ADAPTERS.md maps them.
- **Packaging.** Installs from GitHub while the package is not on npm:
  `npx github:spacesheep-dev/sessionpipe-gui`, `npm i -g github:…`, or a clone with
  `npm install && npm start` (`prepare` builds once, with the bundled extensions from the
  tracked copy); no source maps in the tarball; a plain "needs Node 20 or newer" instead
  of a stack trace on an old Node; a `v*` tag makes a GitHub Release with the tarball
  (npm publishing waits for the `PUBLISH_NPM` variable; RELEASING.md).
- **Phone.** The QR code with the UI key, a responsive layout, a PWA manifest and
  service worker.

[Unreleased]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.7...HEAD
[0.8.7]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.5...v0.8.0
[0.7.5]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/spacesheep-dev/sessionpipe-gui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/spacesheep-dev/sessionpipe-gui/releases/tag/v0.1.0
