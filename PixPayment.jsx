import { useState, useEffect } from 'react'

export default function PixPayment({ orderId, totalValue, onPaymentComplete }) {
  const [pixData, setPixData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(600) // 10 minutos
  const [paymentStatus, setPaymentStatus] = useState('pending')

  useEffect(() => {
    generatePix()
    startPaymentVerification()
  }, [orderId])

  // Timer de expiração
  useEffect(() => {
    if (timeRemaining <= 0) return

    const timer = setInterval(() => {
      setTimeRemaining(prev => prev - 1)
    }, 1000)

    return () => clearInterval(timer)
  }, [timeRemaining])

  // Verificação automática de pagamento a cada 5 segundos
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
    }, 5000)

    return () => clearInterval(interval)
  }

  const generatePix = async () => {
    setLoading(true)
    try {
      const response = await fetch(`http://localhost:3001/api/payments/pix/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, amount: totalValue })
      })

      const data = await response.json()
      setPixData(data)
    } catch (error) {
      console.error('Erro ao gerar PIX:', error)
    }
    setLoading(false)
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(pixData.pixCopyPaste)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
        <p className="mt-4 text-gray-600">Gerando código PIX...</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-purple-100 rounded-full mb-4">
          <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Pagamento via PIX</h2>
        <p className="text-gray-600">Escaneie o QR Code ou copie o código</p>
      </div>

      {/* Timer de expiração */}
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-semibold text-purple-800">Tempo restante:</span>
        </div>
        <div className="text-3xl font-bold text-purple-600">{formatTime(timeRemaining)}</div>
        <p className="text-sm text-purple-700 mt-1">O código PIX expira em 10 minutos</p>
      </div>

      {/* Valor */}
      <div className="text-center mb-6">
        <p className="text-sm text-gray-600 mb-1">Valor a pagar</p>
        <p className="text-4xl font-bold text-gray-800">R$ {totalValue.toFixed(2).replace('.', ',')}</p>
      </div>

      {/* QR Code */}
      <div className="bg-white border-2 border-gray-200 rounded-lg p-6 mb-6 flex justify-center">
        <img
          src={pixData.qrCodeBase64}
          alt="QR Code PIX"
          className="w-64 h-64"
        />
      </div>

      {/* Código Copia e Cola */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          PIX Copia e Cola
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={pixData.pixCopyPaste}
            readOnly
            className="flex-1 px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 font-mono text-sm"
          />
          <button
            onClick={copyToClipboard}
            className={`px-6 py-3 rounded-lg font-medium transition flex items-center gap-2 ${
              copied
                ? 'bg-green-500 text-white'
                : 'bg-purple-600 text-white hover:bg-purple-700'
            }`}
          >
            {copied ? (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                Copiado!
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copiar
              </>
            )}
          </button>
        </div>
      </div>

      {/* Instruções */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-800 mb-2 flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Como pagar
        </h3>
        <ol className="text-sm text-blue-700 space-y-1 list-decimal list-inside">
          <li>Abra o app do seu banco</li>
          <li>Escolha a opção PIX</li>
          <li>Escaneie o QR Code ou cole o código</li>
          <li>Confirme o pagamento</li>
          <li>Pronto! Você receberá a confirmação por email</li>
        </ol>
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
            <p className="text-green-700">Seu pagamento foi aprovado com sucesso.</p>
          </div>
        </div>
      )}

    </div>
  )
}
