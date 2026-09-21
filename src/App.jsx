import React, { useState, useEffect, createContext } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import HomePage from './pages/HomePage'
import AboutPage from './pages/AboutPage'
import ContractRewritePage from './pages/ContractRewritePage'
import ContractDraftPage from './pages/ContractDraftPage'
import LaborConsultPage from './pages/LaborConsultPage'
import QRCodeModal from './components/QRCodeModal'

export const QRCodeContext = createContext()

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
    <QRCodeContext.Provider value={{ openQRModal }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/aboutus" element={<AboutPage />} />
          <Route path="/contract-rewrite" element={<ContractRewritePage />} />
          <Route path="/contract-draft" element={<ContractDraftPage />} />
          <Route path="/labor-consult" element={<LaborConsultPage />} />
        </Routes>
        <QRCodeModal isOpen={isQRModalOpen} onClose={closeQRModal} />
      </BrowserRouter>
    </QRCodeContext.Provider>
  )
}

export default App
