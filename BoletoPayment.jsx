import { useState, useEffect } from 'react'

export default function BoletoPayment({ orderId, totalValue, onPaymentComplete }) {
  const [boletoData, setBoletoData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState('pending')

  useEffect(() => {
    generateBoleto()
    startPaymentVerification()
  }, [orderId])

  // Verificação automática de pagamento a cada 10 segundos
  const startPaymentVerification = () => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:3001/api/orders/${orderId}`)
        const order = await response.json()

        if (order.paymentStatus === 'paid') {
          setPaymentStatus('paid')
          clearInterval(interval)
          if (onPaymentComplete) {
            onPaymentComplete(order)
          }
        }
      } catch (error) {
        console.error('Erro ao verificar pagamento:', error)
      }
    }, 10000)

    return () => clearInterval(interval)
  }

  const generateBoleto = async () => {
    setLoading(true)
    try {
      const response = await fetch(`http://localhost:3001/api/payments/boleto/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, amount: totalValue })
      })

      const data = await response.json()
      setBoletoData(data)
    } catch (error) {
      console.error('Erro ao gerar Boleto:', error)
    }
    setLoading(false)
  }

  const copyBarcode = () => {
    navigator.clipboard.writeText(boletoData.barcode)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }

  const downloadBoleto = () => {
    window.open(boletoData.pdfUrl, '_blank')
  }

  const openBoleto = () => {
    window.open(boletoData.pdfUrl, '_blank')
  }

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="mt-4 text-gray-600">Gerando boleto bancário...</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
          <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Boleto Bancário</h2>
        <p className="text-gray-600">Seu boleto foi gerado com sucesso</p>
      </div>

      {/* Informações do Boleto */}
      <div className="bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 rounded-lg p-6 mb-6">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <p className="text-sm text-blue-700 mb-1">Valor</p>
            <p className="text-2xl font-bold text-blue-900">R$ {totalValue.toFixed(2).replace('.', ',')}</p>
          </div>
          <div>
            <p className="text-sm text-blue-700 mb-1">Vencimento</p>
            <p className="text-2xl font-bold text-blue-900">{boletoData.dueDate}</p>
          </div>
        </div>
        <div>
          <p className="text-sm text-blue-700 mb-1">Beneficiário</p>
          <p className="font-semibold text-blue-900">{boletoData.beneficiary}</p>
        </div>
      </div>

      {/* Código de Barras */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Código de Barras
        </label>
        <div className="bg-white border-2 border-gray-200 rounded-lg p-4 mb-3">
          <div className="font-mono text-center text-lg tracking-wider">
            {boletoData.barcode}
          </div>
        </div>
        <button
          onClick={copyBarcode}
          className={`w-full py-3 rounded-lg font-medium transition flex items-center justify-center gap-2 ${
            copied
              ? 'bg-green-500 text-white'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {copied ? (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              Código Copiado!
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copiar Código de Barras
            </>
          )}
        </button>
      </div>

      {/* Botões de Ação */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <button
          onClick={openBoleto}
          className="bg-gradient-to-r from-blue-600 to-blue-700 text-white py-3 px-4 rounded-lg hover:from-blue-700 hover:to-blue-800 transition font-medium flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Visualizar Boleto
        </button>
        <button
          onClick={downloadBoleto}
          className="bg-gradient-to-r from-green-600 to-green-700 text-white py-3 px-4 rounded-lg hover:from-green-700 hover:to-green-800 transition font-medium flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Baixar PDF
        </button>
      </div>

      {/* Status de verificação */}
      {paymentStatus === 'pending' && (
        <div className="mt-6 text-center">
          <div className="inline-flex items-center gap-2 text-gray-600">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
            <span className="text-sm">Aguardando confirmação do pagamento...</span>
          </div>
        </div>
      )}

      {paymentStatus === 'paid' && (
        <div className="mt-6">
          <div className="bg-green-50 border-2 border-green-500 rounded-lg p-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-500 rounded-full mb-4">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-2xl font-bold text-green-800 mb-2">Pagamento Confirmado!</h3>
            <p className="text-green-700">Seu boleto foi pago com sucesso.</p>
          </div>
        </div>
      )}

    </div>
  )
}
