import styles from "./PhoneShowcase.module.css";

/**
 * Two landing sections that show the app as it looks on a phone: paying from
 * collateral, then the reserve that covers the position. The screens are
 * drawn in HTML with example amounts; they are illustrations, not live data,
 * except for the borrow rate.
 *
 * @param props.rate Live borrow rate, already formatted (for example
 * "3.10%"), or `null` when rates could not be read.
 * @param props.display Class of the display typeface used for the headings.
 */
export function PhoneShowcase({ rate, display }: { rate: string | null; display: string }) {
  return (
    <>
      <section className={styles.section}>
        <div className={styles.copy}>
          <p className={styles.kicker}>01 · Borrow</p>
          <h2 className={`${styles.title} ${display}`}>Post collateral. Borrow at the best rate.</h2>
          <p className={styles.lead}>
            Your bitcoin goes in as collateral and stays yours. Each payment borrows exactly its amount in USDC, from
            the cheapest lender Ardoise uses on Arc.
          </p>
          <ul className={styles.lines}>
            <li>Nothing is sold, swapped or bridged by hand.</li>
            <li>One payment, one line on your slate.</li>
            <li>Everything runs on Arc mainnet.</li>
          </ul>
        </div>
        <div className={styles.phoneWrap}>
          <div className={styles.phone}>
            <div className={styles.screen}>
              <p className={styles.screenLabel}>Pay</p>
              <p className={styles.amount}>
                24.00 <span>USDC</span>
              </p>
              <dl className={styles.rows}>
                <div>
                  <dt>To</dt>
                  <dd>0x7c3f…a91e · Base</dd>
                </div>
                <div>
                  <dt>Borrowed at</dt>
                  <dd>{rate ?? "best rate"}</dd>
                </div>
                <div>
                  <dt>Collateral</dt>
                  <dd>cirBTC, untouched</dd>
                </div>
                <div>
                  <dt>Margin after</dt>
                  <dd className={styles.good}>2.31</dd>
                </div>
              </dl>
              <p className={styles.cta}>Pay 24.00 USDC</p>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.reverse}`}>
        <div className={styles.copy}>
          <p className={styles.kicker}>02 · Cover</p>
          <h2 className={`${styles.title} ${display}`}>Add liquidity. Our bot covers your exposure.</h2>
          <p className={styles.lead}>
            Keep a reserve of USDC next to your position. When the market moves against you, the Ardoise keeper repays
            your debt with it before a liquidation can happen.
          </p>
          <ul className={styles.lines}>
            <li>The bot can only repay your own account.</li>
            <li>
              Other currencies for the reserve <span className={styles.soon}>Soon</span>
            </li>
            <li>
              Staking the reserve while it waits <span className={styles.soon}>Soon</span>
            </li>
          </ul>
        </div>
        <div className={styles.phoneWrap}>
          <div className={`${styles.phone} ${styles.phoneAlt}`}>
            <div className={styles.screen}>
              <p className={styles.screenLabel}>Protection</p>
              <div className={styles.gauge} aria-hidden="true">
                <span />
              </div>
              <p className={styles.gaugeNote}>
                Margin <strong>2.31</strong> · guard at 1.25
              </p>
              <dl className={styles.rows}>
                <div>
                  <dt>Reserve</dt>
                  <dd>120.00 USDC</dd>
                </div>
                <div>
                  <dt>Keeper</dt>
                  <dd className={styles.good}>watching</dd>
                </div>
                <div>
                  <dt>Last repayment</dt>
                  <dd>0.40 USDC</dd>
                </div>
              </dl>
              <p className={styles.cta}>Add to reserve</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
