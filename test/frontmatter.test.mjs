import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter } from '../source/opencode/frontmatter.mjs';

test('parseFrontmatter separates YAML metadata from Markdown content', () => {
  const parsed = parseFrontmatter(
    '---\ndescription: Test agent\nmodel: gpt-5.6-luna\n---\n\nBody\n\n---\n'
  );

  assert.deepEqual(parsed.data, {
    description: 'Test agent',
    model: 'gpt-5.6-luna',
  });
  assert.equal(parsed.content, '\nBody\n\n---\n');
});

test('parseFrontmatter supports CRLF input without altering the body', () => {
  const parsed = parseFrontmatter(
    '---\r\ndescription: Test agent\r\n---\r\n\r\nBody\r\n'
  );

  assert.deepEqual(parsed.data, { description: 'Test agent' });
  assert.equal(parsed.content, '\r\nBody\r\n');
});

test('parseFrontmatter leaves content without frontmatter unchanged', () => {
  assert.deepEqual(parseFrontmatter('Body\n'), {
    data: {},
    content: 'Body\n',
  });
});

test('parseFrontmatter errors include the source path', () => {
  assert.throws(
    () => parseFrontmatter('---\ndescription: "unterminated\n---\nBody', 'agent.md'),
    /Failed to parse frontmatter in agent\.md/
  );
});
