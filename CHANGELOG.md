# v13.3.0 - Sentence-boundary splitter (streaming spec, build step 1)

Implements Sections 6.1, 6.2 and 8. NOTHING IS WIRED and no behaviour changes -
Section 10.2 puts the splitter first, no audio, so phrase emission is proven
before anything depends on it.

Section 10.3 ANSWERED FROM THE CODE FIRST, and it narrows the work:
synthesizeProsodyStream ALREADY does bounded parallel synthesis with ordered
commit (FR-2.2, NFR-4.2), and the browser already owns per-phrase playback. The
gap is only that the client calls speakRow() AFTER the reply completes. Building
Section 6 as written would duplicate a working worker pool.

The contract is a character OFFSET, not a phrase index: boundaries are not stable
under growth ("Dr." looks final until " Smith" arrives), so indexing a list that
can be re-cut causes a repeat or a skip. That also gives idempotency for free.

Two bugs found by testing: a protected region must force phrase edges at BOTH ends
(skipping over it let a code block and the following sentence be spoken as ONE
utterance with the code in the middle), and the ceiling was not hard (a 136-char
sentence passed a 50-char limit because a boundary had been found).

22 tests, mutation-tested three ways. Connector 643/643.

Full detail in CHANGELOG-v13.3.0.md.

