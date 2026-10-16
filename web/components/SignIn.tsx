'use client';
import React from 'react';
import { useState } from 'react';
export function SignIn({
  local,
  configured,
}: {
  local: boolean;
  configured: boolean;
}) {
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  async function login(tenant: string) {
    setPending(true);
    try {
      const r = await fetch('/api/auth/fixture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant }),
      });
      if (!r.ok) throw Error('Test sign-in unavailable');
      new BroadcastChannel('continuum-session').postMessage('changed');
      location.assign('/console/work');
    } catch {
      setError('Test sign-in unavailable. No production identity was used.');
      setPending(false);
    }
  }
  return (
    <main className="sign-in">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          C
        </span>
        <span>
          ASENTXIA <small>CONTINUUM</small>
        </span>
      </div>
      <div className="entry">
        <p className="eyebrow">GOVERNED OPERATING ENVIRONMENT</p>
        <h1>
          Work that continues.
          <br />
          <span>Decisions you can trust.</span>
        </h1>
        <p>
          Review exact actions, follow evidence and recover without blind
          retries.
        </p>
        {local ? (
          <>
            <div className="notice">
              LOCAL TEST ENVIRONMENT · P1 PARTIAL
              <br />
              These are signed test identities, not production sign-in.
            </div>
            <button
              className="primary"
              disabled={pending}
              onClick={() => login('a')}
            >
              Enter local test workspace
            </button>
            <button
              className="quiet"
              disabled={pending}
              onClick={() => login('b')}
            >
              Enter second test workspace
            </button>
          </>
        ) : configured ? (
          <a className="button primary" href="/auth/sign-in">
            Sign in with WorkOS
          </a>
        ) : (
          <div className="notice">
            Configuration required: connect approved WorkOS/AuthKit staging
            sign-in. The production console remains closed.
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <p className="muted small">
          Production blocked · Canary no-go · No credentials requested here.
        </p>
      </div>
    </main>
  );
}
