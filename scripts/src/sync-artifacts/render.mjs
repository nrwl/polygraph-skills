import { Liquid } from 'liquidjs';

const liquid = new Liquid();

export function transformArguments(content, targetPlaceholder) {
  if (targetPlaceholder === null) {
    return content.replace(/^.*\$ARGUMENTS.*$\n?/gm, '');
  }
  if (targetPlaceholder === '$ARGUMENTS') {
    return content;
  }
  return content.replace(/\$ARGUMENTS/g, targetPlaceholder);
}

export function transformContent(content, platformKey) {
  const result = liquid.parseAndRenderSync(content, { platform: platformKey });
  const normalized =
    platformKey === 'claude'
      ? result
      : result.replace(/Claude Code/g, 'AI agent');
  return normalized.replace(/\n{3,}/g, '\n\n');
}
