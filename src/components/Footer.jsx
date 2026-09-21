import React from 'react'
import './Footer.css'

const Footer = () => {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-content">
          <div className="footer-section">
            <h4>快速入口</h4>
            <ul>
              <li><a href="#">法飞飞AI用工风险专家</a></li>
              <li><a href="#">劳动合同分析</a></li>
              <li><a href="#">劳动仲裁答辩</a></li>
              <li><a href="#">员工手册诊断</a></li>
            </ul>
          </div>
          
          <div className="footer-section">
            <h4>联系我们</h4>
            <ul>
              <li><strong>客服热线：</strong><a href="tel:18557207998">185 5720 7998</a></li>
              <li><strong>工作时间：</strong>9:00-18:00（工作日）</li>
              <li><strong>邮箱：</strong><a href="mailto:service@fafeifei.com">xialvshi01@flylegal.cn</a></li>
              <li><strong>地址：</strong>浙江省杭州市萧山区金二路617号信息港六期科大讯飞浙江总部</li>
            </ul>
          </div>
          
          <div className="footer-section">
            <h4>服务与支持</h4>
            <ul>
              <li><strong>商务合作：</strong><a href="mailto:business@fafeifei.com">xialvshi01@flylegal.cn</a></li>
              <li><strong>技术支持：</strong><a href="mailto:support@fafeifei.com">xialvshi01@flylegal.cn</a></li>
              <li><strong>在线客服：</strong>24小时在线服务</li>
            </ul>
          </div>
          
          <div className="footer-section">
            <h4>关于法飞飞AI</h4>
            <ul>
              <li>法飞飞AI用工风险小程序</li>
              <li>科大讯飞、梅花创投等领衔投资</li>
              <li>首席法律顾问夏孙明律师</li>
            </ul>
          </div>
        </div>
        
        <div className="footer-links">
          <span className="footer-links-title">友情链接</span>
          <a href="#">劳动合同分析</a>
          <a href="#">劳动仲裁答辩</a>
          <a href="#">员工手册诊断</a>
          <a href="#">背调信息收集</a>
          <a href="#">医疗期计算器</a>
          <a href="#">商业合同审核</a>
          <a href="#">养老保险测算</a>
        </div>
      </div>
      
      <div className="footer-bottom">
      </div>
    </footer>
  )
}

export default Footer

