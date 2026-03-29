export default function TestPage() {
  return (
    <div style={{ padding: 20, fontFamily: "system-ui" }}>
      <h1>Travel Bookmark - Test Page</h1>
      <p>If you can see this, the server is working.</p>
      <p>時間：{new Date().toISOString()}</p>
    </div>
  );
}
