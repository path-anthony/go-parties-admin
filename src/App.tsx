import "./app.css";
import { ItemsPage } from "./components/ItemsPage";

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="wordmark">
          <span className="wordmark-go">GO!</span> EVENT GROUP
        </div>
      </header>
      <main>
        <ItemsPage />
      </main>
    </div>
  );
}

export default App;
