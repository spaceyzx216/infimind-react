import React, { useState, useEffect, createContext } from 'react'
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './pages/HomePage'
import AboutPage from './pages/AboutPage'
import ContractRewritePage from './pages/ContractRewritePage'
import ContractDraftPage from './pages/ContractDraftPage'
import LaborConsultPage from './pages/LaborConsultPage'
import LaborContractAnalysisPage from './pages/LaborContractAnalysisPage'
import LaborArbitrationPage from './pages/LaborArbitrationPage'
import AuthPage from './pages/AuthPage'
import ToolConversationPage from './pages/ToolConversationPage'
import MedicalCalculatorPage from './pages/MedicalCalculatorPage'
import PensionCalculationPage from './pages/PensionCalculationPage'
import CitationVerificationComparePage from './pages/CitationVerificationComparePage'
import QRCodeModal from './components/QRCodeModal'
import { AuthProvider, useAuth } from './components/AuthProvider'
import WorkspaceLayout from './components/WorkspaceLayout'

export const QRCodeContext = createContext()

function ProtectedPage({ children }) {
  const location = useLocation()
  const { user, status } = useAuth()
  if (status === 'loading') return <div className="auth-loading">正在验证登录状态…</div>
  if (user) return React.cloneElement(children, { key: user.id })
  const redirect = `${location.pathname}${location.search}`
  return <Navigate to={`/auth?mode=login&redirect=${encodeURIComponent(redirect)}`} replace />
}

function App() {
  const [isQRModalOpen, setIsQRModalOpen] = useState(false)

  // 确保任何路由页面挂载后 body 都可见。
  // index.css 中 body 默认 opacity:0，仅当存在 .loaded 时为 opacity:1。
  // 原先只有 HomePage 会添加该 class，导致直接访问 /contract-rewrite
  // 或 /aboutus（含整页刷新、无痕窗口）时 body 始终透明 → 白屏但 DOM 完整。
  // 在根组件统一添加，避免每个页面各自处理。
  useEffect(() => {
    document.body.classList.add('loaded')
  }, [])

  const openQRModal = () => {
    setIsQRModalOpen(true)
  }

  const closeQRModal = () => {
    setIsQRModalOpen(false)
  }

  return (
    <AuthProvider>
      <QRCodeContext.Provider value={{ openQRModal }}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/aboutus" element={<AboutPage />} />
            <Route element={<ProtectedPage><WorkspaceLayout /></ProtectedPage>}>
              <Route path="/labor-consult" element={<LaborConsultPage />} />
              <Route path="/contract-rewrite" element={<ContractRewritePage />} />
              <Route path="/contract-draft" element={<ContractDraftPage />} />
              <Route path="/tools" element={<Navigate to="/labor-consult" replace />} />
              <Route path="/tools/contract-review" element={<ContractRewritePage />} />
              <Route path="/tools/contract-draft" element={<ContractDraftPage />} />
              <Route path="/tools/labor-consult" element={<LaborConsultPage />} />
              <Route path="/tools/labor-contract" element={<LaborContractAnalysisPage />} />
              <Route path="/tools/arbitration" element={<LaborArbitrationPage />} />
              <Route path="/tools/medical-calculator" element={<MedicalCalculatorPage />} />
              <Route path="/tools/pension-calc1" element={<PensionCalculationPage toolId="pension-calc1" />} />
              <Route path="/tools/pension-calc2" element={<PensionCalculationPage toolId="pension-calc2" />} />
              <Route path="/tools/:toolId" element={<ToolConversationPage />} />
            </Route>
            <Route path="/auth" element={<AuthPage />} />
            {import.meta.env.DEV && <Route path="/__demo/citation-verification" element={<CitationVerificationComparePage />} />}
          </Routes>
          <QRCodeModal isOpen={isQRModalOpen} onClose={closeQRModal} />
        </BrowserRouter>
      </QRCodeContext.Provider>
    </AuthProvider>
  )
}

export default App
