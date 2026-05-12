export default function Home() {
  return (
    <main
      style={{
        padding: '4rem 2rem',
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
        maxWidth: '640px',
        margin: '0 auto',
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🎉 Confetti</h1>
      <p style={{ color: '#555', marginBottom: '2rem' }}>
        Quietly runs the joyful parts of your team's culture — birthdays and anniversaries.
      </p>
      <a
        href="/api/slack/install"
        style={{
          display: 'inline-block',
          padding: '0.75rem 1.5rem',
          background: '#4A154B',
          color: 'white',
          borderRadius: '8px',
          textDecoration: 'none',
          fontWeight: 600,
        }}
      >
        Add to Slack
      </a>
    </main>
  );
}
