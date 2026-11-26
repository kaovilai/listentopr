import { describe, expect, it } from 'vitest'
import { contentHash, parsePastedContent } from './paste'
import { pseudoRefNumber } from './github'

// Long enough / structured enough to parse; shared by several cases.
const MULTI_FILE_PASTE = [
  '# Fix login flow',
  '',
  'Explains the change in prose.',
  'Second prose paragraph.',
  '',
  '![diagram](https://example.com/d.png)',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  'diff --git a/src/login.ts b/src/login.ts',
  'index 111..222 100644',
  '--- a/src/login.ts',
  '+++ b/src/login.ts',
  '@@ -1,4 +1,5 @@',
  ' import x',
  '-old line',
  '+new line',
  '+new line 2',
  ' context',
  'diff --git a/package-lock.json b/package-lock.json',
  'index 333..444 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,2 +1,2 @@',
  ' {',
  '-  "old": 1',
  '+  "new": 2',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 000..555 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+line a',
  '+line b',
].join('\n')

describe('parsePastedContent', () => {
  it('parses a multi-file unified diff with prose, filtering generated files', () => {
    const data = parsePastedContent(MULTI_FILE_PASTE)
    expect(data).not.toBeNull()

    // title from the markdown heading
    expect(data!.title).toBe('Fix login flow')
    // per-content pasted ref + content hash as headSha
    expect(data!.ref).toEqual({
      owner: 'pasted',
      repo: 'content',
      number: pseudoRefNumber(`paste:${contentHash(MULTI_FILE_PASTE)}`),
    })
    expect(data!.headSha).toBe(contentHash(MULTI_FILE_PASTE))
    expect(data!.author).toBe('pasted')

    // package-lock.json filtered out, kept files in order
    expect(data!.files.map((f) => f.filename)).toEqual(['src/login.ts', 'src/new.ts'])
    expect(data!.changedFiles).toBe(2)

    const login = data!.files[0]!
    expect(login.additions).toBe(2)
    expect(login.deletions).toBe(1)
    expect(login.status).toBe('modified')
    // patch starts at the @@ hunk marker, runs to the next file header
    expect(login.patch!.split('\n')[0]).toBe('@@ -1,4 +1,5 @@')
    expect(login.patch).toContain('+new line 2')
    expect(login.patch).not.toContain('diff --git')

    // new file: filename from +++ b/, status added, /dev/null handled
    const added = data!.files[1]!
    expect(added.status).toBe('added')
    expect(added.additions).toBe(2)
    expect(added.deletions).toBe(0)

    // totals summed over kept files only
    expect(data!.additions).toBe(4)
    expect(data!.deletions).toBe(1)

    // prose (outside diff blocks) becomes the body
    expect(data!.body).toContain('Explains the change in prose.')
    expect(data!.body).not.toContain('diff --git')
    expect(data!.body).not.toContain('@@ -1,4 +1,5 @@')

    // images + mermaid extracted from the prose
    expect(data!.imageUrls).toEqual(['https://example.com/d.png'])
    expect(data!.mermaidBlocks).toEqual(['graph TD\nA-->B'])

    expect(data!.comments).toEqual([])
    expect(data!.reviews).toEqual([])
  })

  it('uses a deleted file\'s --- a/ path when +++ is /dev/null', () => {
    const text = [
      'Some long enough prose line one to pass the length gate.',
      'prose two',
      'prose three',
      '',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index 111..000 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-gone line',
      '-gone line 2',
    ].join('\n')
    const data = parsePastedContent(text)
    expect(data).not.toBeNull()
    expect(data!.files).toHaveLength(1)
    const f = data!.files[0]!
    expect(f.filename).toBe('src/old.ts')
    expect(f.status).toBe('deleted')
    expect(f.additions).toBe(0)
    expect(f.deletions).toBe(2)
    expect(data!.changedFiles).toBe(1)
  })

  it('tolerates svn-style Index: blocks', () => {
    const text = [
      'Enough prose to clear every gate in the parser here.',
      'more prose',
      'even more',
      '',
      'Index: src/svn.ts',
      '===================================================================',
      '--- src/svn.ts\t(revision 3)',
      '+++ src/svn.ts\t(working copy)',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const data = parsePastedContent(text)
    expect(data).not.toBeNull()
    expect(data!.files).toHaveLength(1)
    const f = data!.files[0]!
    expect(f.filename).toBe('src/svn.ts')
    expect(f.additions).toBe(1)
    expect(f.deletions).toBe(1)
    expect(f.patch!.split('\n')[0]).toBe('@@ -1 +1 @@')
  })

  it('falls back to the first non-empty line as title, truncated to 100 chars', () => {
    const longLine = 'x'.repeat(140)
    const text = [
      longLine,
      'body line two',
      'body line three',
      'body line four',
    ].join('\n')
    const data = parsePastedContent(text)
    expect(data).not.toBeNull()
    expect(data!.title).toBe('x'.repeat(100))
    expect(data!.files).toEqual([])
    expect(data!.changedFiles).toBe(0)
    expect(data!.body).toContain('body line two')
  })

  it('returns null for short pastes', () => {
    expect(parsePastedContent('too short')).toBeNull()
    expect(parsePastedContent('')).toBeNull()
    expect(parsePastedContent('  ')).toBeNull()
  })

  it('returns null for long unstructured garbage', () => {
    expect(parsePastedContent('x'.repeat(200))).toBeNull()
    expect(parsePastedContent('no structure at all just one long rambling line of text here')).toBeNull()
  })

  it('returns null when a diff block is the only content but the paste is too short', () => {
    const tiny = ['diff --git a/a b/a', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    expect(parsePastedContent(tiny)).toBeNull()
  })

  it('parses git-quoted diff paths (spaces in filenames)', () => {
    const text = [
      '# Quoted paths',
      '',
      'Some prose so the paste parses cleanly alongside the diff.',
      '',
      'diff --git "a/src/a b.ts" "b/src/a b.ts"',
      'index 111..222 100644',
      '--- "a/src/a b.ts"',
      '+++ "b/src/a b.ts"',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-old line',
      '+new line',
      '+new line 2',
    ].join('\n')
    const data = parsePastedContent(text)
    expect(data).not.toBeNull()
    expect(data!.files).toHaveLength(1)
    const f = data!.files[0]!
    expect(f.filename).toBe('src/a b.ts')
    expect(f.additions).toBe(2)
    expect(f.deletions).toBe(1)
    expect(data!.changedFiles).toBe(1)
    // the diff lines are recognized as a block, not dumped into the body
    expect(data!.body).not.toContain('diff --git')
    expect(data!.body).not.toContain('@@ -1,2 +1,3 @@')
  })

  it('parses a git-quoted deleted file with a space in its name', () => {
    const text = [
      'Enough prose to clear every gate in the parser here.',
      'more prose',
      'even more',
      '',
      'diff --git "a/old file.ts" "b/old file.ts"',
      'deleted file mode 100644',
      'index 111..000 100644',
      '--- "a/old file.ts"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    ].join('\n')
    const data = parsePastedContent(text)
    expect(data).not.toBeNull()
    expect(data!.files).toHaveLength(1)
    expect(data!.files[0]!.filename).toBe('old file.ts')
    expect(data!.files[0]!.status).toBe('deleted')
    expect(data!.files[0]!.deletions).toBe(1)
  })

  it('keys two different pastes onto different refs (no resume/listen collision)', () => {
    const a = parsePastedContent(MULTI_FILE_PASTE)
    const b = parsePastedContent(MULTI_FILE_PASTE.replace('Fix login flow', 'Fix logout flow'))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.headSha).not.toBe(b!.headSha)
    expect(a!.ref.number).not.toBe(b!.ref.number)
  })
})

describe('contentHash', () => {
  it('is deterministic for identical input', () => {
    expect(contentHash(MULTI_FILE_PASTE)).toBe(contentHash(MULTI_FILE_PASTE))
  })

  it('differs for different input', () => {
    expect(contentHash('aaa')).not.toBe(contentHash('aab'))
    expect(contentHash('')).not.toBe(contentHash('a'))
  })

  it('produces a lowercase hex string', () => {
    expect(contentHash('some pasted content')).toMatch(/^[0-9a-f]+$/)
    expect(contentHash('some pasted content').length).toBe(32)
  })
})
