'use client';
import React, { useState } from 'react';
import type { HumanCommand } from '@continuum/contracts';
import { sealModelKey } from '@/lib/api';

export function ModelText({ text }: { text: string }) {
  return <p className="model-text">{text}</p>;
}

export function ModelConnectionPanel({
  csrf,
  canAct,
  busy,
  onCommand,
  onClose,
}: {
  csrf: string;
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [principal, setPrincipal] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const target = connectionId || 'gemini-' + crypto.randomUUID();
  const limits = {
    maxRequests: 5,
    maxInputChars: 1000,
    maxOutputChars: 1000,
    maxConcurrent: 1 as const,
    timeoutMs: 5000,
  };
  async function create() {
    setPending(true);
    setError('');
    try {
      await onCommand({
        schema_version: 1,
        idempotency_key: crypto.randomUUID(),
        kind: 'create_model_connection',
        target,
        expected_version: 0,
        input: { name },
      });
      setConnectionId(target);
    } catch {
      setError('Connection was not recorded.');
    } finally {
      setPending(false);
    }
  }
  async function seal() {
    setPending(true);
    setError('');
    const key = apiKey;
    setApiKey('');
    try {
      await sealModelKey(connectionId, key, csrf);
    } catch {
      setError('The key was not stored. It was not written into a command.');
    } finally {
      setPending(false);
    }
  }
  async function send(
    kind: HumanCommand['kind'],
    input: HumanCommand['input'],
  ) {
    setPending(true);
    setError('');
    try {
      await onCommand({
        schema_version: 1,
        idempotency_key: crypto.randomUUID(),
        kind,
        target: connectionId,
        expected_version: 0,
        input,
      });
    } catch {
      setError('The command was not applied.');
    } finally {
      setPending(false);
    }
  }
  const held = !canAct || busy || pending;
  return (
    <form className="command-form" onSubmit={(event) => event.preventDefault()}>
      <p className="eyebrow">CONNECT A MODEL</p>
      <h2>Gemini</h2>
      <p>
        Provider usage may cost money. These limits count requests and text
        size. They are not a spending cap.
      </p>
      <p>
        Status: mock-tested / live test pending. A live Gemini test has not
        passed.
      </p>
      <label>
        Connection name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={held || !name || !!connectionId}
        onClick={create}
      >
        Record connection
      </button>
      <label>
        API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={held || !connectionId || !apiKey}
        onClick={seal}
      >
        Store key on the server
      </button>
      <button
        type="button"
        disabled={held || !connectionId}
        onClick={() => send('set_model_connection_limits', limits)}
      >
        Set request and text limits
      </button>
      <button
        type="button"
        disabled={held || !connectionId}
        onClick={() => send('test_model_connection', {})}
      >
        Test connection (explicit provider action)
      </button>
      <label>
        Model reported by the test
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={held || !connectionId || !model}
        onClick={() => send('select_model_connection_model', { model })}
      >
        Choose model
      </button>
      <label>
        VERA
        <input
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={held || !connectionId || !principal}
        onClick={() => send('assign_model_connection', { principal })}
      >
        Assign to VERA
      </button>
      <button
        type="button"
        disabled={held || !connectionId}
        onClick={() => send('revoke_model_connection', {})}
      >
        Disconnect
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </form>
  );
}

export function TryVeraForm({
  connectionId,
  principal,
  canAct,
  busy,
  onCommand,
  onClose,
}: {
  connectionId: string;
  principal: string;
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  async function submit() {
    setError('');
    try {
      await onCommand({
        schema_version: 1,
        idempotency_key: crypto.randomUUID(),
        kind: 'try_vera_text',
        target: connectionId,
        expected_version: 0,
        input: { principal, text },
      });
      setAnswer('');
      setError('The response is in the command result. No tool was enabled.');
    } catch {
      setError('The text request was not sent.');
    }
  }
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <h2>Try VERA</h2>
      <p>
        One text task. No tools, browsing, account actions, or background
        autonomy. Live Gemini remains pending.
      </p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        disabled={!canAct || busy || !text}
        onClick={submit}
      >
        Send text
      </button>
      {answer ? <ModelText text={answer} /> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </form>
  );
}
