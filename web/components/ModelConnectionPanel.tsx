'use client';
import React, { useEffect, useState } from 'react';
import type { HumanCommand } from '@continuum/contracts';
import { read, sealModelKey } from '@/lib/api';

export function ModelText({ text }: { text: string }) {
  return <p className="model-text">{text}</p>;
}

type ConnectionFields = {
  id?: string;
  status?: string;
  model?: string | null;
  supportedModels?: string[];
  verification?: string;
  remainingRequests?: number | null;
};

export function ModelConnectionPanel({
  csrf,
  canAct,
  busy,
  existing,
  onCommand,
  onClose,
}: {
  csrf: string;
  canAct: boolean;
  busy: boolean;
  existing?: ConnectionFields | null;
  onCommand: (value: HumanCommand) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [connectionId, setConnectionId] = useState(existing?.id ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(existing?.model ?? '');
  const [principal, setPrincipal] = useState('');
  const [veras, setVeras] = useState<{ id: string; name: string }[]>([]);
  const [limits, setLimits] = useState({
    maxRequests: 5,
    maxInputChars: 1000,
    maxOutputChars: 1000,
    maxOutputTokens: 128,
    maxResponseBytes: 8192,
    maxConcurrent: 1 as const,
    timeoutMs: 5000,
  });
  const [error, setError] = useState('');
  const [status, setStatus] = useState(
    existing?.verification ?? 'not verified',
  );
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (existing?.id) setConnectionId(existing.id);
    if (existing?.model) setModel(existing.model);
    if (existing?.verification) setStatus(existing.verification);
  }, [existing?.id, existing?.model, existing?.verification]);
  useEffect(() => {
    let cancelled = false;
    read('agents')
      .then((page) => {
        if (cancelled) return;
        setVeras(
          page.items
            .filter((item) => item.kind === 'vera')
            .map((item) => ({ id: item.id, name: item.title || item.id })),
        );
      })
      .catch(() => {
        if (!cancelled) setVeras([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const target = connectionId || 'gemini-' + crypto.randomUUID();
  const models = existing?.supportedModels ?? [];
  async function send(
    kind: HumanCommand['kind'],
    input: HumanCommand['input'],
  ) {
    setPending(true);
    setError('');
    try {
      const receipt = (await onCommand({
        schema_version: 1,
        idempotency_key: crypto.randomUUID(),
        kind,
        target: connectionId || target,
        expected_version: 0,
        input,
      })) as {
        status?: string;
        result?: { message?: string; outcome?: string; verification?: string };
      };
      if (receipt?.status === 'DENIED') {
        setError('The command was denied. Nothing was marked successful.');
        return;
      }
      if (receipt?.result?.verification) setStatus(receipt.result.verification);
      else if (receipt?.result?.message) setStatus(receipt.result.message);
      else if (receipt?.result?.outcome) setStatus(receipt.result.outcome);
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
        Provider usage may cost money. These limits count requests, text size,
        response bytes and a provider token bound. They are not a spending cap.
      </p>
      <p role="status">{status}</p>
      <label>
        Connection name
        <input
          aria-label="Connection name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={held || !name || !!connectionId}
        onClick={async () => {
          const id = target;
          await send('create_model_connection', { name });
          setConnectionId(id);
        }}
      >
        Record connection
      </button>
      <label>
        API key
        <input
          aria-label="API key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={held || !connectionId || !apiKey}
        onClick={async () => {
          setPending(true);
          setError('');
          const key = apiKey;
          setApiKey('');
          try {
            await sealModelKey(connectionId, key, csrf);
            setStatus('Key stored. The connection is not verified.');
          } catch {
            setError('The key was not stored.');
          } finally {
            setPending(false);
          }
        }}
      >
        Store key on the server
      </button>
      <label>
        Max requests
        <input
          aria-label="Max requests"
          type="number"
          value={limits.maxRequests}
          onChange={(event) =>
            setLimits({ ...limits, maxRequests: Number(event.target.value) })
          }
        />
      </label>
      <label>
        Max input characters
        <input
          aria-label="Max input characters"
          type="number"
          value={limits.maxInputChars}
          onChange={(event) =>
            setLimits({ ...limits, maxInputChars: Number(event.target.value) })
          }
        />
      </label>
      <label>
        Max displayed characters
        <input
          aria-label="Max displayed characters"
          type="number"
          value={limits.maxOutputChars}
          onChange={(event) =>
            setLimits({ ...limits, maxOutputChars: Number(event.target.value) })
          }
        />
      </label>
      <label>
        Provider output token bound
        <input
          aria-label="Provider output token bound"
          type="number"
          value={limits.maxOutputTokens}
          onChange={(event) =>
            setLimits({
              ...limits,
              maxOutputTokens: Number(event.target.value),
            })
          }
        />
      </label>
      <p>Not a dollar spending cap.</p>
      <button
        type="button"
        disabled={held || !connectionId}
        onClick={() => send('set_model_connection_limits', limits)}
      >
        Save limits
      </button>
      <button
        type="button"
        disabled={held || !connectionId}
        onClick={() => send('test_model_connection', {})}
      >
        Test connection
      </button>
      <label>
        Model
        <select
          aria-label="Model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="">Choose a reported model</option>
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
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
        <select
          aria-label="VERA"
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
        >
          <option value="">Choose a VERA</option>
          {veras.map((vera) => (
            <option key={vera.id} value={vera.id}>
              {vera.name}
            </option>
          ))}
        </select>
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
  answer,
  canAct,
  busy,
  onCommand,
  onClose,
}: {
  connectionId: string;
  principal: string;
  answer: string;
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<unknown>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <h2>Try VERA</h2>
      <p>
        One text task. No tools, browsing, account actions, or background
        autonomy. Live Gemini remains not run.
      </p>
      <textarea
        aria-label="Task text"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        disabled={!canAct || busy || !text}
        onClick={async () => {
          setError('');
          try {
            const receipt = (await onCommand({
              schema_version: 1,
              idempotency_key: crypto.randomUUID(),
              kind: 'try_vera_text',
              target: connectionId,
              expected_version: 0,
              input: { principal, text },
            })) as { status?: string };
            if (receipt?.status === 'DENIED')
              setError('The command was denied. Nothing was sent.');
          } catch {
            setError('The text request was not sent.');
          }
        }}
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
