# Wish Circle product notes

## Vision

Every child who makes a story book should be able to **step inside it**. Wish Circle takes the
book a child already made, with their words, their characters and their drawings, and gives it
back as a comic they can read aloud and print, and as a game they can play. The child is the author.
The app is the stage.

It started with *Mousie*, a comic by a 6-year-old (see `../mousie-game/`), turned into a game by
hand. Wish Circle makes that possible for any child's book, privately, on the family's own device.

## Users

- **The child (about 4–9)** is the author and player. They may not read fluently yet, so they rely
  on pictures, icons, big buttons and read-aloud. They want to see their own characters do their
  own story, and to show it off.
- **The parent or guardian** sets things up, types or photographs the book with the child, and
  manages profiles, backups and sharing. They want it to be safe, private, ad-free and quick to
  start, with nothing to sign up for.

## Jobs to be done

- *When my child finishes a story book,* I want to turn it into something they can play, so their
  effort feels celebrated and they want to write the next one.
- *When we read together,* I want the comic to read the characters' lines aloud in different
  voices, so my child can follow along and join in.
- *When my child wants to show grandparents,* I want to print the comic or send the book file, so
  it can be shared without putting it online.
- *When several children use one iPad,* I want each to have their own shelf, so nobody's book gets
  changed or deleted by a sibling.
- *As a parent,* I want to be sure nothing my child makes is uploaded, tracked or shown ads.

## MVP scope

- First-run setup: parent passcode, first child profile. Restore from a backup on a new device.
- Child profiles with an avatar, a colour and an optional picture lock.
- Bookshelf per child, with an example book (Pip the bunny) to try straight away.
- Story editor: type or paste the story, add photos of the book's pages, review the detected cast
  (with emoji or the child's own drawing as a character), places and action moments.
- Comic reader: panels with speech bubbles and narration captions, page turns, read-aloud, and a
  print layout.
- Game: story pages and levels in order. Level types are journey (run and jump), battle,
  treasure hunt, climb, meet friends and a final celebration. There are stars but no way to lose.
- Parent area: profiles, encrypted backup and restore, change passcode, import and export books
  (`.wishbook`), auto-lock, erase everything, and a plain-language privacy explainer.
- Installable PWA for iPhone, iPad and Mac. Works offline after the first visit.

Not in the MVP: accounts, cloud sync, any network feature, handwriting recognition, AI.

## Principles

1. **Private by design.** No servers, no accounts, no analytics, no ads, no links out. Everything
   is encrypted at rest. Anything that would send data off the device is opt-in, parent-only and
   clearly explained, and is never added quietly.
2. **Child-led.** The child's words and pictures come first. The app suggests (cast, places,
   actions) and the child decides. It never "corrects" the story.
3. **No failure states.** Levels can't be lost. Every tap does something fun. Stars reward
   finishing, not skill.
4. **Read-aloud everywhere.** Anything a child needs to understand can be heard. Icons always come
   with labels, and tap targets are at least 64 px.
5. **Calm and warm.** A storybook-paper look, no streaks, no notifications and no pressure to keep
   playing.
6. **Simple to run.** Static files, no build step, works from any HTTPS host or a laptop.

## Roadmap (after the MVP)

- **On-device handwriting OCR (optional).** Read the words straight from photos of the child's
  pages, fully on the device, with the parent reviewing the text before it's used.
- **Parent-consented AI story helper (optional, off by default).** Help to split pages, name
  characters or suggest level moments. It would only run after a parent turns it on, would show
  exactly what is sent and where, and would never be needed to use the app. On-device models
  are preferred.
- **Family sharing.** Send a book to a relative as an encrypted link or file that opens in their
  copy of Wish Circle, without a server that can read it.
- **More level types.** Swimming, flying, a maze, a puzzle, a music level, and "draw your own
  obstacle".
- **Richer characters.** Pose the child's drawn characters (walk, jump, cheer) from one drawing.
- **Accessibility.** Switch control and keyboard play, high-contrast mode, dyslexia-friendly
  text option, more voices and languages.
