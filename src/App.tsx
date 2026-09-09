import "./app.css";
import { AdminShell } from "./components/AdminShell";
import { AuthGate } from "./components/AuthGate";

function App() {
  return (
    <AuthGate>
      <AdminShell />
    </AuthGate>
  );
}

export default App;
