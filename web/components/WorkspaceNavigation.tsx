'use client';
import React from 'react';
import Link from 'next/link';

export const dailyDestinations = [
  ['work', 'Work'],
  ['projects', 'Projects'],
  ['agents', 'VERAs'],
  ['approvals', 'Approvals'],
  ['integrations', 'Connections'],
] as const;

export const advancedDestinations = [
  ['evidence', 'Evidence'],
  ['recovery', 'Recovery'],
  ['incidents', 'Incidents'],
  ['notifications', 'Notifications'],
  ['governance', 'Governance'],
  ['authority', 'Authority'],
  ['security', 'Security'],
  ['computers', 'Computers'],
  ['context', 'State / Context'],
  ['usage', 'Usage / Limits'],
  ['settings', 'Settings'],
  ['setup', 'Onboarding / Setup'],
] as const;

export const workspaceTitles: Record<string, string> = Object.fromEntries([
  ...dailyDestinations,
  ...advancedDestinations,
]);

export function WorkspaceNavigation({ section }: { section: string }) {
  const advancedActive = advancedDestinations.some(([id]) => id === section);
  function destination([id, title]: readonly [string, string]) {
    return (
      <Link
        key={id}
        href={'/console/' + id}
        aria-current={section === id ? 'page' : undefined}
        className={section === id ? 'active' : ''}
      >
        <span className="nav-glyph" aria-hidden>
          {id === 'work'
            ? '◈'
            : id === 'approvals'
              ? '✓'
              : id === 'agents'
                ? '◇'
                : '·'}
        </span>
        {title}
      </Link>
    );
  }
  return (
    <>
      <div className="nav-group" role="group" aria-label="Everyday work">
        <p className="nav-heading" aria-hidden>
          Your workspace
        </p>
        {dailyDestinations.map(destination)}
      </div>
      <details className="advanced-navigation" open={advancedActive}>
        <summary>More workspace tools</summary>
        <div className="nav-group" role="group" aria-label="Workspace tools">
          <p className="nav-explanation">
            Inspect history, permissions and technical details.
          </p>
          {advancedDestinations.map(destination)}
        </div>
      </details>
    </>
  );
}
