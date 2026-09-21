import React, { useState } from 'react'
import {
  Brain,
  FileText,
  Scale,
  BookOpen,
  Calculator,
  Building2,
  User
} from 'lucide-react'
import './ProductSection.css'

const ProductSection = () => {
  const [activeProduct, setActiveProduct] = useState('ai-assistant')

  const products = [
    {
      id: 'ai-assistant',
      icon: Brain,
      title: '法飞飞AI用工风险助手',
      desc: '智能AI助手，一站式解决企业全流程用工风险管理问题',
      video: '/法飞飞AI.mp4'
    },
    {
      id: 'labor-contract',
      icon: FileText,
      title: '劳动合同分析',
      desc: '分析劳动合同结构、风险点，提供专业的合同审查建议',
      video: '/劳动合同1.mp4'
    },
    {
      id: 'arbitration',
      icon: Scale,
      title: '劳动仲裁答辩',
      desc: '生成仲裁胜率分析、专业建议及完整的证据清单',
      video: '/劳动仲裁1.mp4'
    },
    {
      id: 'handbook',
      icon: BookOpen,
      title: '员工手册诊断',
      desc: '智能分析员工手册风险点，提供合规性改进建议',
      video:  '/员工手册.mp4'
    },
    {
      id: 'medical-calculator',
      icon: Calculator,
      title: '医疗期计算器',
      desc: '准确计算医疗期，提供相关法规依据和支持建议',
      video: '/医疗期计算器1.mp4'
    },
    {
      id: 'pension-calc1',
      icon: Building2,
      title: '养老保险测算',
      desc: '针对企业职工的养老保险精准测算',
      video: '/养老保险1.mp4'
    },
    {
      id: 'pension-calc2',
      icon: User,
      title: '灵活就业保险测算',
      desc: '针对个体工商户或灵活职业者的保险测算',
      video: '/养老保险1.mp4'
    },
  ]

  return (
    <section id="products" className="product-section section-scroll">
      <div className="container">
        <div className="section-header fade-in-up">
          <span className="section-label">产品矩阵</span>
          <h2 className="section-title">法飞飞AI功能预览</h2>
          <p className="section-desc">基于AI技术的智能用工风险管理工具，为企业提供全方位的用工合规保障</p>
        </div>
        
        <div className="product-showcase">
          <div className="product-menu fade-in-up-delay-1">
            {products.map((product) => {
              const IconComponent = product.icon
              return (
                <div
                  key={product.id}
                  className={`product-menu-item ${activeProduct === product.id ? 'active' : ''}`}
                  onClick={() => setActiveProduct(product.id)}
                  onMouseEnter={() => setActiveProduct(product.id)}
                >
                  <div className="product-icon">
                    <IconComponent size={24} />
                  </div>
                  <h3>{product.title}</h3>
                  <p>{product.desc}</p>
                  <a href="https://jsj.top/f/NctQWw" target="_blank" rel="noopener noreferrer" className="learn-more">了解更多 →</a>
                </div>
              )
            })}
          </div>
          
          <div className="product-display fade-in-up-delay-2">
            {products.map((product) => (
              <div
                key={product.id}
                className={`product-image ${activeProduct === product.id ? 'active' : ''}`}
                data-product={product.id}
              >
                {product.video ? (
                  <video
                    className="product-video"
                    src={product.video}
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                ) : (
                  <div className="product-img-placeholder">
                    {product.title}演示
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        
        <div className="section-cta">
          <a className="primary-btn" href="https://jsj.top/f/NctQWw" target="_blank" rel="noopener noreferrer">立即体验</a>
        </div>
      </div>
    </section>
  )
}

export default ProductSection
