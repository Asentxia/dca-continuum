export const fixturePriv = '/usr/local/sbin/continuum-fixture-priv';
const drop = [
  '--clear-groups',
  '--no-new-privs',
  '--bounding-set=-all',
  '--inh-caps=-all',
  '--ambient-caps=-all',
];
export function unshareIsolated(uid: number, command: string[]) {
  return [
    '-n',
    fixturePriv,
    'unshare',
    `--reuid=${uid}`,
    `--regid=${uid}`,
    ...drop,
    '--',
    ...command,
  ];
}
export function nsenterIsolated(pid: number, uid: number, command: string[]) {
  return [
    '-n',
    fixturePriv,
    'nsenter',
    `--target=${pid}`,
    `--reuid=${uid}`,
    `--regid=${uid}`,
    ...drop,
    '--',
    ...command,
  ];
}
