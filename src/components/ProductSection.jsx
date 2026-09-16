import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ArrowRight, BookOpen, Brain, Building2, Calculator, FileEdit,
  FilePenLine, FileText, Scale, User
} from 'lucide-react'
import './ProductSection.css'

const products = [
  { id: 'ai-assistant', group: '用工风险工具', icon: Brain, title: '法飞飞AI用工风险助手', desc: '围绕企业日常用工问题，提供场景化风险分析和处理建议。', video: '/法飞飞AI.mp4' },
  { id: 'labor-contract', group: '用工风险工具', icon: FileText, title: '劳动合同分析', desc: '分析劳动合同结构和风险点，给出可执行的审查建议。', video: '/劳动合同1.mp4' },
  { id: 'arbitration', group: '用工风险工具', icon: Scale, title: '劳动仲裁答辩', desc: '梳理争议焦点、证据缺口、风险判断与答辩思路。', video: '/劳动仲裁1.mp4' },
  { id: 'handbook', group: '用工风险工具', icon: BookOpen, title: '员工手册诊断', desc: '检查制度内容与制定程序，发现用工合规风险。', video: '/员工手册.mp4' },
  { id: 'medical-calculator', group: '用工风险工具', icon: Calculator, title: '医疗期计算器', desc: '结合地区、工龄和司龄，展示医疗期计算过程。', video: '/医疗期计算器1.mp4' },
  { id: 'pension-calc1', group: '用工风险工具', icon: Building2, title: '企业职工养老保险测算', desc: '测算企业职工养老保险缴费与待遇。', video: '/养老保险1.mp4' },
  { id: 'pension-calc2', group: '用工风险工具', icon: User, title: '灵活就业保险测算', desc: '比较个体工商户或灵活就业人员的缴费方案。', video: '/养老保险1.mp4' },
  { id: 'contract-review', group: '商业合同工具', icon: FileEdit, title: '商业合同审查与批注', desc: '上传合同，定位条款风险并生成可逐项核对的批注稿。', ready: true },
  { id: 'contract-draft', group: '商业合同工具', icon: FilePenLine, title: '商业合同智能起草', desc: '说明交易背景和诉求，生成结构完整的合同初稿。', ready: true }
]

const productGroups = ['用工风险工具', '商业合同工具']

export default function ProductSection() {
  const location = useLocation()
  const selected = useMemo(() => new URLSearchParams(location.search).get('product'), [location.search])
  const [activeProduct, setActiveProduct] = useState(selected && products.some((item) => item.id === selected) ? selected : 'ai-assistant')
  const active = products.find((item) => item.id === activeProduct) || products[0]

  useEffect(() => {
    if (selected && products.some((item) => item.id === selected)) setActiveProduct(selected)
  }, [selected])

  return (
    <section id="products" className="product-section section-scroll">
      <div className="container">
        <div className="section-header fade-in-up">
          <span className="section-label">产品矩阵</span>
          <h2 className="section-title">法飞飞AI功能预览</h2>
          <p className="section-desc">基于AI技术的智能法律工具，为企业提供清晰、可执行的风险处理支持</p>
        </div>
        <div className="product-showcase">
          <div className="product-menu fade-in-up-delay-1">
            {productGroups.map((group) => <div className="product-menu-group" key={group}>
              {products.filter((product) => product.group === group).map((product) => {
                const Icon = product.icon
                return (
                  <button type="button" key={product.id} className={`product-menu-item ${activeProduct === product.id ? 'active' : ''}`} onClick={() => setActiveProduct(product.id)} onMouseEnter={() => setActiveProduct(product.id)}>
                    <span className="product-icon"><Icon size={22} /></span>
                    <span className="product-menu-copy"><strong>{product.title}</strong><small>{product.desc}</small></span>
                    <ArrowRight className="product-menu-arrow" size={18} />
                  </button>
                )
              })}
            </div>)}
          </div>
          <div className="product-display fade-in-up-delay-2">
            {active.video ? (
              <video key={active.id} className="product-video" src={active.video} autoPlay loop muted playsInline />
            ) : (
              <div className="product-workbench-preview">
                <div className="preview-rail"><i /><i /><i /><i /></div>
                <div className="preview-sheet">
                  <span>法飞飞 AI</span><h3>{active.title}</h3>
                  <p>{active.id === 'contract-review' ? '上传合同或输入你特别关注的审查重点…' : '描述合同类型、交易背景和你希望保护的立场…'}</p>
                  <div className="preview-prompt"><b>＋</b><span>在这里开始一项新任务</span><em>↑</em></div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="section-cta"><Link className="primary-btn" to="/tools">立即体验</Link></div>
      </div>
    </section>
  )
}
