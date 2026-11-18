import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, setUnauthorizedHandler } from "./api";
import Board from "./Board";
import { closeLive } from "./live";
import Login from "./Login";
import TaskPage from "./TaskPage";

type AuthState = "checking" | "in" | "out";
const NEXT_KEY = "kanban:next";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api.me().then(() => setAuth("in")).catch(() => setAuth("out"));
  }, []);

  const toLogin = useCallback(() => {
    closeLive();
    setAuth("out");
  }, []);
  useEffect(() => setUnauthorizedHandler(toLogin), [toLogin]);

  useEffect(() => {
    if (auth === "out" && location.pathname !== "/login") {
      try { sessionStorage.setItem(NEXT_KEY, location.pathname + location.search); } catch { /* ignore */ }
    }
  }, [auth, location.pathname, location.search]);

  if (auth === "checking") return <div className="center-note">Загрузка…</div>;

  if (auth === "out") {
    return (
      <Routes>
        <Route path="/login" element={<Login onSuccess={() => setAuth("in")} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const logout = async () => {
    await api.logout().catch(() => {});
    closeLive();
    setAuth("out");
    navigate("/login", { replace: true });
  };

  return (
    <Routes>
      <Route path="/" element={<Board onLogout={logout} />} />
      <Route path="/t/:id" element={<TaskPage />} />
      <Route path="/login" element={<AfterLogin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** After a successful login (or visiting /login while signed in) go back to the page that asked for auth. */
function AfterLogin() {
  const [next] = useState(() => {
    let n = "/";
    try { n = sessionStorage.getItem(NEXT_KEY) || "/"; } catch { /* ignore */ }
    return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/";
  });
  useEffect(() => { try { sessionStorage.removeItem(NEXT_KEY); } catch { /* ignore */ } }, []);
  return <Navigate to={next} replace />;
}
