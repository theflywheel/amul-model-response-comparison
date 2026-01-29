import { useState, FormEvent } from 'react'

type LoginFormProps = {
  onLogin: (mobileNumber: string) => void
}

function LoginForm({ onLogin }: LoginFormProps) {
  const [mobileNumber, setMobileNumber] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = mobileNumber.trim()
    if (!trimmed || trimmed.length < 10) {
      setError('Please enter a valid mobile number (at least 10 digits)')
      return
    }
    onLogin(trimmed)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white shadow rounded-lg px-6 py-8 max-w-md w-full">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Model Response Comparison
        </h1>
        <p className="text-sm text-gray-600 mb-6">
          Please enter your mobile number to continue. This will be used as your
          user ID for tracking your selections.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="mobile"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Mobile Number
            </label>
            <input
              id="mobile"
              type="tel"
              value={mobileNumber}
              onChange={(e) => {
                setMobileNumber(e.target.value)
                setError(null)
              }}
              placeholder="Enter your mobile number"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            {error && (
              <p className="mt-1 text-xs text-red-600">{error}</p>
            )}
          </div>
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  )
}

export default LoginForm
