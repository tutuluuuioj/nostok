import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Gate, Restricted } from './components/Gate.jsx';
import { Shell } from './components/Shell.jsx';
import { ErrorBoundary } from './components/ui.jsx';
import { getFrontendConfig } from './lib/contracts.js';
import { Alerts } from './pages/Alerts.jsx';
import { Borrow } from './pages/Borrow.jsx';
import { Builders } from './pages/Builders.jsx';
import { Data } from './pages/Data.jsx';
import { Home } from './pages/Home.jsx';
import { Lend } from './pages/Lend.jsx';
import { Loan } from './pages/Loan.jsx';
import { Loans } from './pages/Loans.jsx';
import { Markets } from './pages/Markets.jsx';
import { Positions } from './pages/Positions.jsx';
import { Risk } from './pages/Risk.jsx';
import { Terms } from './pages/Terms.jsx';
import { Wallet } from './pages/Wallet.jsx';
import { StoreProvider, useStore } from './store.jsx';

function Frame() {
  const { state } = useStore();
  if (state.gate === 'restricted') return <Restricted />;
  if (state.gate !== 'accepted') return <Gate />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/markets" element={<Markets />} />
        <Route path="/borrow" element={<Borrow />} />
        <Route path="/lend" element={<Lend />} />
        <Route path="/loans" element={<Loans />} />
        <Route path="/loans/:id" element={<Loan />} />
        <Route path="/loan/:id" element={<Loan />} />
        <Route path="/positions" element={<Positions />} />
        <Route path="/risk" element={<Risk />} />
        <Route path="/data" element={<Data />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/builders" element={<Builders />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  let configError = null;
  try {
    getFrontendConfig();
  } catch (err) {
    configError = err instanceof Error ? err : new Error(String(err));
  }
  return (
    <ErrorBoundary initialError={configError}>
      <StoreProvider>
        <BrowserRouter>
          <Frame />
        </BrowserRouter>
      </StoreProvider>
    </ErrorBoundary>
  );
}
