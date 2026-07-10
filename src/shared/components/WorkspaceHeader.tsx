import type { ReactNode } from "react";

export function WorkspaceHeader({ kicker, title, description, actions, meta }: {
  kicker: string;
  title: string;
  description: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return <header className="workspace-header">
    <div className="workspace-titleblock">
      <span className="workspace-kicker">{kicker}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {meta && <div className="workspace-meta">{meta}</div>}
    </div>
    {actions && <div className="workspace-actions">{actions}</div>}
  </header>;
}
