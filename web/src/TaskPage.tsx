import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Board } from "./api";
import { ArrowLeft, Logo } from "./icons";
import { CopyTaskLink } from "./CopyTaskLink";
import { useLive } from "./live";
import { TaskView, useTask } from "./TaskView";

export default function TaskPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { task, setTask, error, reload } = useTask(id);
  const [meta, setMeta] = useState<Pick<Board, "statuses" | "tags" | "epics"> | null>(null);
  const loadMeta = () => api.board([], "").then((b) => setMeta({ statuses: b.statuses, tags: b.tags, epics: b.epics })).catch(() => {});
  useEffect(() => { void loadMeta(); }, []);
  useLive((e) => { if (!e || e.kind === "tag" || e.kind === "task") void loadMeta(); });
  useEffect(() => { document.title = task ? `#${task.id} ${task.title} — Канбан` : "Канбан"; return () => { document.title = "Канбан"; }; }, [task]);

  // Back to the board keeps the remembered filters (they live in localStorage and are restored by the board).
  return (
    <div className="app">
      <header className="topbar">
        <Link className="brand" to="/"><Logo />Канбан</Link>
      </header>
      <main className="page">
        <nav className="crumbs" aria-label="Навигация">
          <Link to="/"><ArrowLeft size={14} /> Доска</Link>
          <span aria-hidden="true">/</span>
          {task?.epic && <><Link to={`/t/${task.epic.id}`} className="crumb-epic">{task.epic.title}</Link><span aria-hidden="true">/</span></>}
          <span className="mono">{task?.kind === "epic" ? "Эпик " : ""}#{id}</span>
          <span className="spacer" />
          <CopyTaskLink id={id} />
        </nav>
        {error && <div className="center-note" style={{ gridColumn: "1 / -1" }}>{error} <Link to="/">Вернуться к доске</Link></div>}
        {(!task || !meta) && !error && <div className="center-note" style={{ gridColumn: "1 / -1" }}>Загрузка…</div>}
        {task && meta && (
          <TaskView
            key={task.id} task={task} statuses={meta.statuses} tags={meta.tags} epics={meta.epics} variant="page"
            setTask={(t) => { setTask(t); if (t.kind !== task.kind || t.epic_id !== task.epic_id) { void reload(); void loadMeta(); } }}
            reload={() => { void reload(); void loadMeta(); }}
            onOpen={(tid) => navigate(`/t/${tid}`)}
            onDeleted={() => navigate("/", { replace: true })}
          />
        )}
      </main>
    </div>
  );
}
