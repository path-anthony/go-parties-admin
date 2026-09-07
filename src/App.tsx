import { useState } from "react";
import "./app.css";
import { ItemsPage } from "./components/ItemsPage";
import { RecommendDemo } from "./components/RecommendDemo";

type Tab = "items" | "demo";

function App() {
  const [tab, setTab] = useState<Tab>("items");

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="wordmark">
          <span className="wordmark-go">GO!</span> EVENT GROUP
        </div>
        <nav className="tabs">
          <button
            type="button"
            className={tab === "items" ? "tab active" : "tab"}
            onClick={() => setTab("items")}
          >
            Items
          </button>
          <button
            type="button"
            className={tab === "demo" ? "tab active" : "tab"}
            onClick={() => setTab("demo")}
          >
            Ask GO Demo
          </button>
        </nav>
      </header>
      <main>{tab === "items" ? <ItemsPage /> : <RecommendDemo />}</main>
    </div>
  );
}

export default App;
