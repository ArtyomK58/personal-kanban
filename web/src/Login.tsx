import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { Alert, Logo } from "./icons";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [wait, setWait] = useState(0);
  const [scope, setScope] = useState<string | undefined>();
  const [recovered, setRecovered] = useState(false);
  const [busy, setBusy] = useState(false);

  // Count down with an absolute deadline so a backgrounded tab does not drift.
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setWait(left);
      if (!left) { setUntil(0); setRecovered(true); }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  const lock = (sec: number, sc?: string) => { setScope(sc); setRecovered(false); setUntil(Date.now() + sec * 1000); setErr(""); };

  const message = wait > 0
    ? `${scope === "global" ? "Слишком много неудачных попыток входа со всех адресов" : "Слишком много неудачных попыток"}. Повторите через ${fmtWait(wait)}.`
    : err;

  return (
    <main className="login-wrap">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!token.trim() || wait > 0) return;
          setBusy(true);
          try {
            await api.login(token.trim());
            setToken("");
            onSuccess();
          } catch (x) {
            if (x instanceof ApiError && x.status === 429) lock(x.retryAfter ?? 60, x.scope);
            else if (x instanceof ApiError && x.status === 401 && x.retryAfter) lock(x.retryAfter, x.scope);
            else { setRecovered(false); setErr(x instanceof ApiError && x.status === 401 ? "Неверный токен" : "Сервер недоступен, попробуйте ещё раз"); }
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1><Logo />Канбан</h1>
        <div className={`field${message ? " error" : ""}`}>
          <label htmlFor="token">Токен доступа</label>
          <input
            id="token" name="token" type="password" autoComplete="current-password" autoFocus spellCheck={false}
            placeholder="pk_…" value={token} aria-invalid={!!message} aria-describedby={message ? "token-err" : "token-hint"}
            onChange={(e) => { setToken(e.target.value); if (err) setErr(""); }}
          />
          {message && <div className="field-error" id="token-err" role="alert"><Alert size={14} />{message}</div>}
          {!message && recovered && <div className="field-ok" role="status">Можно попробовать снова.</div>}
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || wait > 0 || !token.trim()}>{wait > 0 ? `Войти через ${fmtWait(wait)}` : "Войти"}</button>
        <p id="token-hint">Вход запоминается на этом устройстве — токен вводится один раз. Токен создаётся при первом запуске сервера (файл <span className="mono">bootstrap-token.txt</span> в каталоге данных), подробнее — в README.</p>
      </form>
    </main>
  );
}

function fmtWait(sec: number) {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} мин ${s} с` : `${m} мин`;
}
