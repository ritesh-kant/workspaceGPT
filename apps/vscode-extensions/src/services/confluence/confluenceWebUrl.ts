/** Confluence web links are application-relative, even when they start with '/'.
 * Prefer API base/context metadata; applicationBase is the endpoint's fallback
 * web application base, never the OAuth API gateway. */
export function resolveConfluenceWebUrl(applicationBase: string, link: string, links?: { base?: string; context?: string }): string {
  try {
    const trusted = new URL(applicationBase);
    const allowed = (url: URL) => /^https?:$/.test(url.protocol) && url.origin === trusted.origin && !url.username && !url.password;
    if (!allowed(trusted) || !link) return '';
    if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//')) {
      const absolute = new URL(link, trusted);
      return allowed(absolute) ? absolute.toString() : '';
    }
    let base = trusted;
    if (links?.base) {
      const candidate = new URL(links.base, trusted);
      if (allowed(candidate)) base = candidate;
    }
    if (links?.context !== undefined && base.pathname.replace(/\/$/, '') === '') {
      const context = new URL(links.context.startsWith('/') || /^https?:/i.test(links.context)
        ? links.context || '/' : `/${links.context}`, trusted.origin);
      if (allowed(context)) base = context;
    }
    const contextPath = base.pathname.replace(/\/$/, '');
    const rooted = link.startsWith('/') ? link : `/${link}`;
    // Some responses already include the context; don't prepend it twice.
    const hasContext = !!contextPath && (rooted === contextPath || rooted.startsWith(`${contextPath}/`) || rooted.startsWith(`${contextPath}?`) || rooted.startsWith(`${contextPath}#`));
    const result = new URL(hasContext ? rooted : `${contextPath}${rooted}`, trusted.origin);
    return allowed(result) ? result.toString() : '';
  } catch { return ''; }
}
