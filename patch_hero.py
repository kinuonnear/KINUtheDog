from pathlib import Path

p = Path("src/main.jsx")
s = p.read_text(encoding="utf-8")

start = s.find('<section className="hero compact">')
if start == -1:
    raise SystemExit("ERROR: hero compact tidak ditemukan")

end = s.find('</section>', start)
if end == -1:
    raise SystemExit("ERROR: penutup Hero tidak ditemukan")

end += len('</section>')

new = """<section className="hero compact">

  <div className="hero-copy">

    <div className="eyebrow">
      KINU / NEAR \\u00b7 LIQUIDITY
    </div>

    <h1>
      Liquidity,
      <br />
      <em>made simple.</em>
    </h1>

    <p>
      Trade tokens. Find liquidity.
      <br />
      Build positions across NEAR.
    </p>

    <div className="hero-actions">

      <button
        type="button"
        className="hero-primary"
        onClick={() => {
          document
            .querySelector('.swap-column')
            ?.scrollIntoView({
              behavior: 'smooth',
              block: 'start'
            });
        }}
      >
        START TRADING
      </button>

      <button
        type="button"
        className="hero-secondary"
        onClick={() => {
          document
            .querySelector('.featured-pools-column')
            ?.scrollIntoView({
              behavior: 'smooth',
              block: 'start'
            });
        }}
      >
        EXPLORE POOLS
      </button>

    </div>

    <div className="status">

      <span
        className={
          ready ? 'ok' : ''
        }
      ></span>

      {ready
        ? 'Meteor ready \\u00b7 Rhea online'
        : 'Loading wallet'}

    </div>

  </div>

</section>"""

s = s[:start] + new + s[end:]
p.write_text(s, encoding="utf-8")

print("PATCH SUCCESS")
print("Hero lama :", "Every pool." in s)
print("Hero baru :", "Liquidity," in s)
print("CTA :", "START TRADING" in s and "EXPLORE POOLS" in s)
