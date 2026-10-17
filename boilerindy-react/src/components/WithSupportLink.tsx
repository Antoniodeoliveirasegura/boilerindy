import { Link } from 'react-router-dom'

// A message that tells the student to contact support (an already linked
// Purdue account, a failed account delete) gets a link to the support page,
// so they are not left to find it themselves.
export default function WithSupportLink({ text }: { text: string }) {
  if (!/contact support/i.test(text)) return <>{text}</>
  return (
    <>
      {text}{' '}
      <Link to="/support" className="prose-link">
        Go to support
      </Link>
    </>
  )
}
