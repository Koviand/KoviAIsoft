import type { ReactNode } from "react";

export type PageNavItem = {
  id: string;
  label: string;
  group?: string;
};

export function PageShell(props: {
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  nav: PageNavItem[];
  children: ReactNode;
  className?: string;
}) {
  const groups = groupNav(props.nav);

  return (
    <div className={`stack-page page-shell${props.className ? ` ${props.className}` : ""}`}>
      <header className="page-header page-header-bar">
        <div className="page-header-text">
          <h1 className="h1">{props.title}</h1>
          {props.subtitle && <p className="muted page-sub">{props.subtitle}</p>}
        </div>
        <div className="page-header-aside">
          {props.meta}
          {props.actions}
        </div>
      </header>

      <div className="page-layout">
        <nav className="page-toc" aria-label="Разделы">
          {groups.map((g) => (
            <div key={g.label || "_"} className="page-toc-group">
              {g.label && <div className="page-toc-label">{g.label}</div>}
              <ul className="page-toc-list">
                {g.items.map((item) => (
                  <li key={item.id}>
                    <a className="page-toc-link" href={`#${item.id}`}>
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="page-content">{props.children}</div>
      </div>
    </div>
  );
}

export function SettingsSection(props: {
  id: string;
  title: string;
  description?: ReactNode;
  elevated?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={props.id}
      className={`card section-card${props.elevated ? " elevated" : ""}`}
    >
      <header className="section-card-head">
        <h3>{props.title}</h3>
        {props.description && <p className="section-card-desc muted">{props.description}</p>}
      </header>
      <div className="section-card-body">{props.children}</div>
    </section>
  );
}

function groupNav(nav: PageNavItem[]): Array<{ label: string; items: PageNavItem[] }> {
  const out: Array<{ label: string; items: PageNavItem[] }> = [];
  for (const item of nav) {
    const label = item.group || "";
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}
