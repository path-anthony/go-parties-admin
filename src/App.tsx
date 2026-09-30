import "./app.css";
import { BrowserRouter } from "react-router-dom";
import { AdminShell } from "./components/AdminShell";
import { AuthGate } from "./components/AuthGate";

function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <AdminShell />
      </AuthGate>
    </BrowserRouter>
  );
}

export default App;
