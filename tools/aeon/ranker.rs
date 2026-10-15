// Continuum std-only numeric bridge; donor code is included unchanged below.
extern crate self as uuid;
pub type Uuid = usize;
mod amp {
    pub mod pressure { pub struct PressureManager; }
    pub mod co_access {
        use std::collections::HashMap;
        pub struct CoAccessGraph(pub HashMap<usize, f64>);
        impl CoAccessGraph {
            pub async fn get_neighbor_weight_sums(&self, ids: &[usize]) -> HashMap<usize, f64> {
                ids.iter().filter_map(|id| self.0.get(id).map(|w| (*id, *w))).collect()
            }
        }
    }
    pub mod augmenter { include!("../../vendor/aeon/augmenter.rs"); }
}
use std::{future::Future, sync::Arc, task::{Context, Poll, Wake, Waker}};
struct ReadyWake;
impl Wake for ReadyWake { fn wake(self: Arc<Self>) {} }
fn ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ReadyWake));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    // This bounded implementation is intentionally synchronous. A changed shim
    // that starts yielding is a refusal, not an unbounded executor loop.
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("unexpected asynchronous dependency"),
    }
}
fn number(text: &str, max: f64) -> Result<f64, ()> {
    if text.len() > 32 { return Err(()); }
    let value: f64 = text.parse().map_err(|_| ())?;
    if !value.is_finite() || value < 0.0 || value > max { return Err(()); }
    Ok(value)
}
fn run() -> Result<(), ()> {
    let args: Vec<String> = std::env::args().skip(1).take(18).collect();
    if args.is_empty() || args.len() > 17 { return Err(()); }
    let bonus = number(&args[0], 1.0)?;
    let mut pairs = Vec::new();
    let mut weights = std::collections::HashMap::new();
    for (id, arg) in args[1..].iter().enumerate() {
        let (distance, weight) = arg.split_once(',').ok_or(())?;
        pairs.push((id, number(distance, 2.0)?));
        weights.insert(id, number(weight, 5.0)?);
    }
    let augmenter = amp::augmenter::RetrievalAugmenter::new(
        amp::pressure::PressureManager, amp::co_access::CoAccessGraph(weights), bonus,
    );
    let result = ready(augmenter.augment_scores((0..pairs.len()).collect(), &pairs));
    for (id, score) in result { println!("{id} {score:.17}"); }
    Ok(())
}
fn main() {
    if run().is_err() { eprintln!("AEON numeric protocol refused"); std::process::exit(2); }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_donor_bonus_clamps_and_preserves_input_order() {
        let weights = [(0, 5.0), (1, 0.5)].into_iter().collect();
        let donor = amp::augmenter::RetrievalAugmenter::new(
            amp::pressure::PressureManager, amp::co_access::CoAccessGraph(weights), 0.15);
        let scored = ready(donor.augment_scores(vec![0, 1, 2], &[(0, 0.1), (1, 0.8), (2, 0.9)]));
        assert_eq!(scored[0], (0, 0.0));
        assert!((scored[1].1 - 0.725).abs() < 1e-12);
        assert_eq!(scored[2], (2, 0.9));
    }
    #[test]
    fn actual_donor_disabled_bonus_is_identity() {
        let donor = amp::augmenter::RetrievalAugmenter::new(
            amp::pressure::PressureManager, amp::co_access::CoAccessGraph(Default::default()), 0.0);
        let pairs = [(0, 0.4), (1, 0.2)];
        assert_eq!(ready(donor.augment_scores(vec![0, 1], &pairs)), pairs);
    }
    #[test]
    fn numeric_boundary() {
        for text in ["NaN", "inf", "-0.1", "2.1", "", "0,1"] { assert!(number(text, 2.0).is_err()); }
        assert_eq!(number("2", 2.0), Ok(2.0));
    }
}
