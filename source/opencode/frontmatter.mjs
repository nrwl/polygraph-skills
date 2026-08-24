import matter from '@11ty/gray-matter';

export function parseFrontmatter(raw, sourcePath) {
  try {
    const { data, content } = matter(raw);
    return { data: data ?? {}, content };
  } catch (error) {
    if (!sourcePath) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse frontmatter in ${sourcePath}: ${message}`, {
      cause: error,
    });
  }
}
