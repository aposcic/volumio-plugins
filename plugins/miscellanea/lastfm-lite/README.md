# lastfm-lite
Plugin to scrobble music played in Volumio 2.x to Last.fm.

Based on the [volumio-lastfm-plugin](https://github.com/Saiyato/volumio-lastfm-plugin).

Changes from the original:
1. Refactored and cleaned up code. Updated syntax.
2. Removed similar artists/tracks functionality. This is purely a scrobbler.
3. Introduced option of removing superfluous info (e.g. 'Remastered Version', 'Explicit') from album and track titles before scrobbling.
4. Tidied up several bugs including properly following startup and shutdown procedures.