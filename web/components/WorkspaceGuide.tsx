'use client';
import React from 'react';
import Link from 'next/link';

type Action = 'task' | 'project' | 'vera' | 'model';
const guides: Record<
  string,
  {
    title: string;
    description: string;
    action: Action;
    actionLabel: string;
    note: string;
  }
> = {
  work: {
    title: 'Start with the outcome you want.',
    description:
      'Keep the work, your AI teammates and the decisions that need you in one place.',
    action: 'task',
    actionLabel: 'Describe a task',
    note: 'Creating a task records the work. It does not start an agent or authorize an external action.',
  },
  projects: {
    title: 'Give related work a home.',
    description:
      'Use a project for a shared outcome, then link the tasks that belong to it.',
    action: 'project',
    actionLabel: 'Organize a project',
    note: 'A project groups work. It does not schedule tasks or change their permissions.',
  },
  agents: {
    title: 'Meet your AI teammates.',
    description:
      'Give a VERA a name and a clear role. Its identity stays the same when you change its model.',
    action: 'vera',
    actionLabel: 'Create a VERA profile',
    note: 'A new VERA starts paused. A model connection, permission to act and autonomous execution are separate capabilities.',
  },
  integrations: {
    title: 'Connect a model. Keep control.',
    description:
      'Manage Gemini connections, choose a model and assign it to a VERA. Keep credentials on the server.',
    action: 'model',
    actionLabel: 'Set up a model connection',
    note: 'Provider calls can cost money. Request and text limits are not a dollar spending cap; connecting does not verify live readiness.',
  },
};

export function WorkspaceGuide({
  section,
  canAct,
  busy,
  onCreate,
}: {
  section: string;
  canAct: boolean;
  busy: boolean;
  onCreate: (action: Action) => void;
}) {
  const guide = guides[section];
  if (section === 'approvals')
    return (
      <section
        className="workspace-guide compact-guide"
        aria-label="Approval guide"
      >
        <div>
          <p className="eyebrow">DECISIONS, NOT GUESSWORK</p>
          <h2>Know exactly what you are allowing.</h2>
          <p>
            Open a request to see the action, affected resource and current
            permission before deciding. Approval is not proof of execution.
          </p>
        </div>
        <Link className="guide-text-link" href="/console/recovery">
          An outcome is uncertain? Review recovery →
        </Link>
      </section>
    );
  if (!guide) return null;
  return (
    <section className="workspace-guide" aria-label="Workspace guide">
      <div className="guide-introduction">
        <div>
          <p className="eyebrow">LESS SETUP. CLEARER NEXT STEPS.</p>
          <h2>{guide.title}</h2>
          <p>{guide.description}</p>
        </div>
        <button
          className="primary"
          disabled={!canAct || busy}
          onClick={() => onCreate(guide.action)}
        >
          {guide.actionLabel}
        </button>
      </div>
      {section === 'work' && (
        <details className="work-path-guide">
          <summary>New here? See the three-step setup</summary>
          <ol className="work-path" aria-label="How to start working">
            <li>
              <span className="path-number" aria-hidden>
                1
              </span>
              <div>
                <strong>Define the work</strong>
                <p>Describe the outcome. Keep related tasks in a project.</p>
                <Link href="/console/projects">Explore projects →</Link>
              </div>
            </li>
            <li>
              <span className="path-number" aria-hidden>
                2
              </span>
              <div>
                <strong>Choose your VERA</strong>
                <p>Create a teammate profile with a clear name and role.</p>
                <Link href="/console/agents">Meet your VERAs →</Link>
              </div>
            </li>
            <li>
              <span className="path-number" aria-hidden>
                3
              </span>
              <div>
                <strong>Connect, then try</strong>
                <p>Assign a model connection and try a bounded text task.</p>
                <Link href="/console/integrations">Manage connections →</Link>
              </div>
            </li>
          </ol>
        </details>
      )}
      <p className="guide-boundary">{guide.note}</p>
      {!canAct && (
        <p className="guide-availability">
          Creation is unavailable until the workspace confirms a fresh,
          authorized session. Navigation and help do not grant permission.
        </p>
      )}
      {section === 'work' && (
        <div className="guide-follow-through">
          <span>When work needs your attention</span>
          <Link href="/console/approvals">Review exact requests</Link>
          <Link href="/console/recovery">Inspect uncertain outcomes</Link>
        </div>
      )}
    </section>
  );
}
